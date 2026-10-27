/**
 * @file server.js
 * @description Code Review Agent 的本地 Web 入口。
 *              使用 Node 原生 HTTP 服务承载页面、静态资源与 SSE 审查事件，
 *              不额外引入 Express 等框架。
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, validateConfig } from "../src/config.js";
import { CodeReviewAgent } from "../src/core/agent.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(CURRENT_DIR, "public");
const MAX_BODY_BYTES = 360_000;
const MAX_QUESTION_CHARS = 4_000;
const SESSION_TTL_MS = 60 * 60 * 1_000;
const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

let config = null;
let configError = null;
try {
  config = loadConfig();
  validateConfig(config);
} catch (err) {
  configError = err.message;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "提交内容过大，请控制在 200 KB 以内。");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON。");
  }
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    throw new HttpError(400, "资源路径不合法。");
  }

  const target = path.resolve(PUBLIC_DIR, decodedPath);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    throw new HttpError(403, "禁止访问该路径。");
  }

  let fileStats;
  try {
    fileStats = await stat(target);
  } catch {
    throw new HttpError(404, "页面或资源不存在。");
  }
  if (!fileStats.isFile()) {
    throw new HttpError(404, "页面或资源不存在。");
  }

  const body = await readFile(target);
  const contentType = MIME_TYPES[path.extname(target)] ?? "application/octet-stream";
  const isHtml = target.endsWith(".html");
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": isHtml ? "no-store" : "public, max-age=3600",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function normalizeSessionId(raw) {
  const value = String(raw ?? "").trim();
  return /^[a-zA-Z0-9-]{8,80}$/.test(value) ? value : randomUUID();
}

function getSessionAgent(sessionId) {
  const now = Date.now();
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeen = now;
    return existing.agent;
  }

  const agent = new CodeReviewAgent(config);
  sessions.set(sessionId, { agent, lastSeen: now });

  // 本地演示服务也做简单容量控制，避免长期运行后会话无限增长。
  if (sessions.size > 40) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  return agent;
}

function buildReviewInput(code, filename) {
  const safeFilename = path
    .basename(filename || "pasted-code.txt")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 120);
  const extension = path.extname(safeFilename).slice(1) || "text";
  return `请审查以下代码。文件名：${safeFilename}，代码语言标记：${extension}。
请先理解完整逻辑，再按系统要求的固定报告结构输出，必要时可使用 execute_code 验证可疑行为。

<source_code filename="${safeFilename.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">
${code}
</source_code>`;
}

function writeSse(res, event) {
  if (res.destroyed || res.writableEnded) return;
  const payload = { ...event, at: Date.now() };
  try {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 浏览器刷新或关闭页面时连接可能先于 Agent 结束，无需中断后台审查。
  }
}

async function handleReview(req, res) {
  if (!config || configError) {
    throw new HttpError(503, `Agent 配置不可用：${configError}`);
  }

  const body = await readJsonBody(req);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!code && !question) {
    throw new HttpError(400, "请先粘贴代码、上传文件，或输入追问。");
  }
  if (code.length > 200_000) {
    throw new HttpError(413, "代码超过 200 KB，请缩小审查范围。");
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new HttpError(413, `追问不能超过 ${MAX_QUESTION_CHARS} 个字符。`);
  }

  const sessionId = normalizeSessionId(body.session_id);
  const agent = getSessionAgent(sessionId);
  const input = code ? buildReviewInput(code, body.filename) : question;
  const startedAt = Date.now();

  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": pulse\n\n");
  }, 15_000);

  writeSse(res, {
    type: "session",
    session_id: sessionId,
    filename: code ? path.basename(body.filename || "pasted-code.txt") : null,
  });

  try {
    await agent.review(input, {
      onEvent: (event) => writeSse(res, event),
    });
    writeSse(res, {
      type: "done",
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    writeSse(res, {
      type: "error",
      message: err?.message || "审查过程中发生未知错误。",
    });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

function cleanupSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.lastSeen < cutoff) sessions.delete(sessionId);
  }
}

setInterval(cleanupSessions, 10 * 60 * 1_000).unref();

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: !configError,
        model: config?.model ?? null,
        tools: ["read_file", "execute_code"],
        configError,
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/review") {
      await handleReview(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      throw new HttpError(405, "该接口不支持此请求方法。");
    }

    await serveStatic(req, res, requestUrl.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : "服务器内部错误。";
    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    } else if (!res.writableEnded) {
      res.end();
    }
    if (!(err instanceof HttpError)) console.error("[web] 未处理异常：", err);
  }
});

const port = Number.parseInt(process.env.PORT || "4173", 10);
const host = "127.0.0.1";

server.listen(port, host, () => {
  console.log(`Code Review Agent UI: http://${host}:${port}`);
  console.log(`Model: ${config?.model ?? "not configured"}`);
  if (configError) console.warn(`Configuration warning: ${configError}`);
});
