/**
 * @file app.js
 * @description Web 工作台交互：源码导入、SSE 事件消费、ReAct 时间线、
 *              审查报告渲染以及会话追问。
 */

const elements = {
  codeInput: document.querySelector("#codeInput"),
  lineNumbers: document.querySelector("#lineNumbers"),
  filenameLabel: document.querySelector("#filenameLabel"),
  languageLabel: document.querySelector("#languageLabel"),
  lineCountLabel: document.querySelector("#lineCountLabel"),
  charCount: document.querySelector("#charCount"),
  estimatedTokens: document.querySelector("#estimatedTokens"),
  unsavedDot: document.querySelector("#unsavedDot"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  analyzeLabel: document.querySelector(".analyze-button .button-label > span"),
  uploadBtn: document.querySelector("#uploadBtn"),
  exampleBtn: document.querySelector("#exampleBtn"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  newAnalysisBtn: document.querySelector("#newAnalysisBtn"),
  liveBadge: document.querySelector("#liveBadge"),
  liveBadgeText: document.querySelector("#liveBadge span"),
  telemetryIdle: document.querySelector("#telemetryIdle"),
  traceView: document.querySelector("#traceView"),
  currentOperation: document.querySelector("#currentOperation"),
  stepCounter: document.querySelector("#stepCounter"),
  traceProgressBar: document.querySelector("#traceProgressBar"),
  timeline: document.querySelector("#timeline"),
  traceWaiting: document.querySelector("#traceWaiting"),
  reportPanel: document.querySelector("#reportPanel"),
  reportContent: document.querySelector("#reportContent"),
  reportTime: document.querySelector("#reportTime"),
  reportMeta: document.querySelector("#reportMeta"),
  highRiskCount: document.querySelector("#highRiskCount"),
  mediumRiskCount: document.querySelector("#mediumRiskCount"),
  lowRiskCount: document.querySelector("#lowRiskCount"),
  copyReportBtn: document.querySelector("#copyReportBtn"),
  followupForm: document.querySelector("#followupForm"),
  followupInput: document.querySelector("#followupInput"),
  followupBtn: document.querySelector("#followupBtn"),
  modelLabel: document.querySelector("#modelLabel"),
  toast: document.querySelector("#toast"),
  cursorGlow: document.querySelector("#cursorGlow"),
  ambientCanvas: document.querySelector("#ambientCanvas"),
};

const state = {
  sessionId: localStorage.getItem("code-review-session") || null,
  filename: "untitled.js",
  running: false,
  report: "",
  controller: null,
  timer: null,
  startedAt: 0,
  step: 0,
  maxSteps: 8,
  configInvalid: false,
  isFollowup: false,
};

const SAMPLE_CODE = `// 订单结算模块 · 待审查样本
function calculateTotal(items) {
  return items.reduce((sum, item) => {
    return sum + item.price * item.quantity;
  }, 0);
}

function applyDiscount(total, coupon) {
  if (coupon.type === "PERCENT") {
    return total - total * coupon.value;
  }
  return total - coupon.amount;
}

async function checkout(order, user) {
  const total = calculateTotal(order.items);
  const payable = applyDiscount(total, user.coupon);
  const response = await fetch("/api/payment", {
    method: "POST",
    body: JSON.stringify({ userId: user.id, amount: payable })
  });
  return response.json();
}`;

const EXTENSION_META = {
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "React JSX",
  ts: "TypeScript",
  tsx: "React TSX",
  py: "Python",
  java: "Java",
  c: "C",
  cc: "C++",
  cpp: "C++",
  h: "C Header",
  hpp: "C++ Header",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  kt: "Kotlin",
  sql: "SQL",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  css: "CSS",
  md: "Markdown",
  txt: "Plain text",
};

let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2800);
}

function getExtension(filename) {
  return filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
}

function updateLanguage() {
  const extension = getExtension(state.filename);
  elements.languageLabel.textContent = EXTENSION_META[extension] || "Source code";
}

function updateEditor() {
  const code = elements.codeInput.value;
  const lines = code ? code.split(/\r?\n/) : [""];
  const visibleLineCount = Math.max(1, lines.length);

  elements.lineNumbers.textContent = Array.from(
    { length: visibleLineCount },
    (_, index) => String(index + 1),
  ).join("\n");
  elements.charCount.textContent = code.length.toLocaleString("en-US");
  elements.estimatedTokens.textContent = Math.ceil(code.length / 4).toLocaleString("en-US");
  elements.lineCountLabel.textContent = `${visibleLineCount.toLocaleString("en-US")} LOC`;
  elements.unsavedDot.classList.toggle("is-visible", code.length > 0);
  elements.filenameLabel.textContent = state.filename;
  elements.analyzeBtn.disabled = state.running || state.configInvalid || code.trim() === "";
  updateLanguage();
  syncEditorScroll();
}

function syncEditorScroll() {
  elements.lineNumbers.scrollTop = elements.codeInput.scrollTop;
}

async function importFile(file) {
  if (!file) return;
  if (file.size > 200_000) {
    showToast("文件超过 200 KB，请先缩小审查范围。", true);
    return;
  }
  if (/^(image|audio|video)\//.test(file.type)) {
    showToast("请提交文本源码文件。", true);
    return;
  }

  try {
    const text = await file.text();
    state.filename = file.name || "uploaded-source.txt";
    elements.codeInput.value = text;
    updateEditor();
    showToast(`已导入 ${state.filename}`);
    elements.codeInput.focus();
  } catch (err) {
    showToast(`读取文件失败：${err.message}`, true);
  }
}

function setBusy(isBusy, options = {}) {
  state.running = isBusy;
  state.isFollowup = Boolean(options.followup);
  elements.analyzeBtn.disabled = isBusy || state.configInvalid || !elements.codeInput.value.trim();
  elements.followupBtn.disabled = isBusy;
  elements.followupInput.disabled = isBusy;
  elements.analyzeLabel.textContent = isBusy ? "分析进行中" : "启动智能审查";
  elements.liveBadge.classList.toggle("is-live", isBusy);
  elements.liveBadgeText.textContent = isBusy ? "LIVE" : "STANDBY";
  elements.telemetryIdle.hidden = isBusy || elements.timeline.children.length > 0;
  elements.traceView.hidden = !isBusy && elements.timeline.children.length === 0;
  elements.traceWaiting.hidden = !isBusy;
}

function resetRunView(options = {}) {
  state.report = "";
  state.step = 0;
  state.maxSteps = 8;
  state.startedAt = Date.now();
  elements.timeline.replaceChildren();
  elements.reportContent.innerHTML = "";
  elements.currentOperation.textContent = "INITIALIZING";
  elements.stepCounter.textContent = "00 / 08";
  elements.traceProgressBar.style.width = "4%";
  elements.traceView.hidden = false;
  elements.telemetryIdle.hidden = true;
  elements.traceWaiting.hidden = false;
  elements.liveBadge.classList.add("is-live");
  elements.liveBadgeText.textContent = "LIVE";
  elements.followupForm.reset();
  if (!options.followup) {
    elements.reportPanel.hidden = true;
  } else {
    elements.reportPanel.classList.add("is-refreshing");
  }
}

function finishRun() {
  if (!state.running) return;
  state.running = false;
  state.controller = null;
  clearInterval(state.timer);
  state.timer = null;
  setBusy(false);
  elements.traceWaiting.hidden = true;
  elements.liveBadge.classList.remove("is-live");
  elements.liveBadgeText.textContent = state.report ? "COMPLETE" : "INTERRUPTED";
  elements.currentOperation.textContent = state.report ? "ANALYSIS COMPLETE" : "RUN INTERRUPTED";
  if (state.report) {
    elements.traceProgressBar.style.width = "100%";
  }
  elements.reportPanel.classList.remove("is-refreshing");
}

function abortCurrentRun() {
  if (!state.running) return;
  state.controller?.abort();
  finishRun();
}

function newAnalysis() {
  abortCurrentRun();
  state.sessionId = null;
  localStorage.removeItem("code-review-session");
  state.filename = "untitled.js";
  state.report = "";
  state.step = 0;
  elements.codeInput.value = "";
  elements.timeline.replaceChildren();
  elements.reportContent.innerHTML = "";
  elements.reportPanel.hidden = true;
  elements.traceView.hidden = true;
  elements.telemetryIdle.hidden = false;
  elements.liveBadge.classList.remove("is-live");
  elements.liveBadgeText.textContent = "STANDBY";
  elements.currentOperation.textContent = "INITIALIZING";
  elements.stepCounter.textContent = "00 / 00";
  elements.traceProgressBar.style.width = "4%";
  elements.followupForm.reset();
  updateEditor();
  elements.codeInput.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatClock(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function addTraceItem(type, title, body, { details = false } = {}) {
  const item = document.createElement("div");
  item.className = `trace-item is-${type}`;

  const card = document.createElement("div");
  card.className = "trace-card";
  const head = document.createElement("div");
  head.className = "trace-card-head";
  head.innerHTML = traceIcon(type);

  const heading = document.createElement("strong");
  heading.textContent = title;
  const time = document.createElement("span");
  time.className = "trace-time";
  time.textContent = formatClock();
  head.append(heading, time);
  card.appendChild(head);

  if (body) {
    if (details) {
      const disclosure = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "展开工具返回值";
      const pre = document.createElement("pre");
      pre.textContent = body;
      disclosure.append(summary, pre);
      card.appendChild(disclosure);
    } else if (type === "action") {
      const pre = document.createElement("pre");
      pre.textContent = body;
      card.appendChild(pre);
    } else {
      const paragraph = document.createElement("p");
      paragraph.textContent = body;
      card.appendChild(paragraph);
    }
  }

  item.appendChild(card);
  elements.timeline.appendChild(item);
  elements.timeline.scrollTop = elements.timeline.scrollHeight;
}

function traceIcon(type) {
  const icons = {
    thought:
      '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 .8-1.5 2-1.5 3h-5c0-1-.5-2.2-1.5-3Z"/></svg>',
    action:
      '<svg viewBox="0 0 24 24"><path d="m14 6 4 4-8 8H6v-4l8-8ZM13 7l4 4M5 20h14"/></svg>',
    observation:
      '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    warning:
      '<svg viewBox="0 0 24 24"><path d="M12 4 3 20h18L12 4ZM12 9v5M12 17h.01"/></svg>',
    error:
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  };
  return icons[type] || icons.thought;
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "session":
      state.sessionId = event.session_id;
      localStorage.setItem("code-review-session", event.session_id);
      if (event.filename) {
        state.filename = event.filename;
        elements.filenameLabel.textContent = event.filename;
      }
      break;
    case "start":
      addTraceItem("thought", "Source stream mounted", "代码样本已进入分析上下文，Agent 开始建立审查路径。");
      break;
    case "step": {
      state.step = event.step;
      state.maxSteps = event.maxSteps;
      const step = String(event.step).padStart(2, "0");
      const maxSteps = String(event.maxSteps).padStart(2, "0");
      elements.stepCounter.textContent = `${step} / ${maxSteps}`;
      elements.traceProgressBar.style.width = `${Math.max(4, (event.step / event.maxSteps) * 92)}%`;
      elements.currentOperation.textContent = "REASONING CHANNEL";
      break;
    }
    case "thought":
      addTraceItem("thought", `Reasoning · Step ${String(event.step).padStart(2, "0")}`, event.content);
      break;
    case "action":
      elements.currentOperation.textContent = `TOOL / ${String(event.action).toUpperCase()}`;
      addTraceItem("action", `Execute · ${event.action}`, event.argsPreview);
      break;
    case "observation":
      elements.currentOperation.textContent = event.ok ? "OBSERVATION RECEIVED" : "TOOL RETURNED ERROR";
      addTraceItem(
        event.ok ? "observation" : "error",
        `Observation · ${event.action}`,
        event.result,
        { details: true },
      );
      break;
    case "warning":
      addTraceItem("warning", "Protocol auto-correction", event.message);
      break;
    case "report":
      state.report = event.content || "";
      renderReport(state.report);
      break;
    case "error":
      addTraceItem("error", "Review interrupted", event.message);
      showToast(event.message, true);
      break;
    case "done":
      finishRun();
      break;
    default:
      break;
  }
}

function renderReport(markdown) {
  elements.reportContent.innerHTML = renderMarkdown(markdown);
  elements.reportPanel.hidden = false;
  const counts = countRiskSignals(markdown);
  elements.highRiskCount.textContent = String(counts.high);
  elements.mediumRiskCount.textContent = String(counts.medium);
  elements.lowRiskCount.textContent = String(counts.low);
  elements.reportTime.textContent = formatClock();
  elements.reportMeta.textContent = `${counts.lineRefs} LINE ANCHORS · ${elements.languageLabel.textContent.toUpperCase()}`;

  requestAnimationFrame(() => {
    elements.reportPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function countRiskSignals(markdown) {
  const count = (pattern) => (markdown.match(pattern) || []).length;
  return {
    high: count(/【\s*高\s*】|\[高\]|[🔴⛔]/g),
    medium: count(/【\s*中\s*】|\[中\]|[🟠⚠️]/g),
    low: count(/【\s*低\s*】|\[低\]|[🟡🔵]/g),
    lineRefs: count(/(?:^|\n)\s*(?:[-*]\s*)?(?:line|L\.?)\s*\d+|第\s*\d+\s*行/gi),
  };
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInline(text) {
  const codeTokens = [];
  let html = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code class="inline">${code}</code>`);
    return token;
  });
  html = html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeTokens[Number(index)]);
  return html;
}

function renderTextBlock(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let listType = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 5);
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(?:---+|\*\*\*+)$/.test(trimmed)) {
      flushParagraph();
      closeList();
      output.push("<hr>");
      continue;
    }

    if (trimmed.startsWith("> ")) {
      flushParagraph();
      closeList();
      output.push(`<blockquote>${renderInline(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    const isTable =
      line.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(lines[index + 1]);
    if (isTable) {
      flushParagraph();
      closeList();
      const rows = [line];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(lines[index]);
        index += 1;
      }
      index -= 1;
      const parseCells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
      const headers = parseCells(rows[0]);
      const bodyRows = rows.slice(1).map(parseCells);
      output.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${bodyRows
          .map(
            (cells) =>
              `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody></table>`,
      );
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const desiredType = unordered ? "ul" : "ol";
      if (listType !== desiredType) {
        closeList();
        listType = desiredType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  return output.join("\n");
}

function renderMarkdown(markdown) {
  const source = String(markdown || "");
  const output = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = fence.exec(source)) !== null) {
    output.push(renderTextBlock(source.slice(cursor, match.index)));
    output.push(`<pre><code>${escapeHtml(match[2].replace(/\n$/, ""))}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  output.push(renderTextBlock(source.slice(cursor)));
  return output.join("\n");
}

async function streamReview(payload, options = {}) {
  if (state.running) return;

  resetRunView(options);
  setBusy(true, options);
  state.controller = new AbortController();
  state.startedAt = Date.now();

  state.timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1_000);
    elements.reportMeta.textContent = `ANALYZING · ${elapsed}s`;
  }, 1_000);

  try {
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.controller.signal,
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await response.json();
        throw new Error(data.error || `请求失败（${response.status}）`);
      }
      throw new Error(`请求失败（${response.status}）`);
    }
    if (!response.body) throw new Error("浏览器不支持流式响应。");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) {
          try {
            handleAgentEvent(JSON.parse(data));
          } catch (err) {
            console.debug("[ui] 无法解析 SSE 事件：", err);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    if (!state.report && state.running) {
      throw new Error("Agent 未返回审查报告，请检查终端日志。");
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      addTraceItem("error", "Connection failure", err.message);
      showToast(err.message, true);
    }
  } finally {
    finishRun();
  }
}

function startReview() {
  const code = elements.codeInput.value.trim();
  if (!code) {
    showToast("请先粘贴代码或上传源码文件。", true);
    return;
  }
  if (code.length > 200_000) {
    showToast("代码超过 200 KB，请缩小审查范围。", true);
    return;
  }
  streamReview(
    {
      code,
      filename: state.filename,
      session_id: state.sessionId,
    },
    { followup: false },
  );
}

function startFollowup(question) {
  const value = question.trim();
  if (!value) return;
  if (!state.sessionId) {
    showToast("当前会话已重置，请重新提交代码。", true);
    return;
  }
  streamReview(
    {
      question: value,
      session_id: state.sessionId,
    },
    { followup: true },
  );
}

async function copyReport() {
  if (!state.report) return;
  try {
    await navigator.clipboard.writeText(state.report);
    showToast("审查报告已复制");
  } catch {
    showToast("复制失败，请手动选择报告内容。", true);
  }
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    state.configInvalid = !data.ok;
    if (data.ok) {
      const model = String(data.model || "agent").toUpperCase();
      elements.modelLabel.textContent = `${model} · READY`;
    } else {
      elements.modelLabel.textContent = "CONFIG REQUIRED";
      setTimeout(() => showToast(`Agent 尚未就绪：${data.configError}`, true), 500);
    }
    updateEditor();
  } catch {
    elements.modelLabel.textContent = "LOCAL · READY";
  }
}

elements.codeInput.addEventListener("input", updateEditor);
elements.codeInput.addEventListener("scroll", syncEditorScroll);
elements.codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = elements.codeInput.selectionStart;
    const end = elements.codeInput.selectionEnd;
    const value = elements.codeInput.value;
    elements.codeInput.value = `${value.slice(0, start)}  ${value.slice(end)}`;
    elements.codeInput.selectionStart = elements.codeInput.selectionEnd = start + 2;
    updateEditor();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    startReview();
  }
});

elements.analyzeBtn.addEventListener("click", startReview);
elements.newAnalysisBtn.addEventListener("click", newAnalysis);
elements.uploadBtn.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  importFile(elements.fileInput.files?.[0]);
  elements.fileInput.value = "";
});
elements.exampleBtn.addEventListener("click", () => {
  state.filename = "checkout-review.js";
  elements.codeInput.value = SAMPLE_CODE;
  updateEditor();
  showToast("示例代码已加载");
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === "dragleave" && elements.dropZone.contains(event.relatedTarget)) return;
    elements.dropZone.classList.remove("is-dragging");
  });
}

elements.dropZone.addEventListener("drop", (event) => {
  importFile(event.dataTransfer?.files?.[0]);
});

elements.followupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = elements.followupInput.value;
  elements.followupInput.value = "";
  startFollowup(question);
});

elements.copyReportBtn.addEventListener("click", copyReport);

window.addEventListener("pointermove", (event) => {
  elements.cursorGlow.style.left = `${event.clientX}px`;
  elements.cursorGlow.style.top = `${event.clientY}px`;
});

function initAmbientCanvas() {
  const canvas = elements.ambientCanvas;
  const context = canvas.getContext("2d");
  if (!context) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let width = 0;
  let height = 0;
  let particles = [];
  let animationFrame = 0;
  const pointer = { x: -1000, y: -1000 };

  function createParticles() {
    const count = Math.max(24, Math.min(62, Math.floor(width / 25)));
    particles = Array.from({ length: count }, (_, index) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12,
      radius: Math.random() * 1.2 + 0.35,
      pink: index % 4 === 0,
    }));
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    createParticles();
    draw();
  }

  function draw() {
    context.clearRect(0, 0, width, height);

    for (let index = 0; index < particles.length; index += 1) {
      const point = particles[index];
      if (!reducedMotion) {
        point.x += point.vx;
        point.y += point.vy;
        if (point.x < -10) point.x = width + 10;
        if (point.x > width + 10) point.x = -10;
        if (point.y < -10) point.y = height + 10;
        if (point.y > height + 10) point.y = -10;
      }

      const pointerDistance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
      const glow = pointerDistance < 180 ? 1 - pointerDistance / 180 : 0;
      context.beginPath();
      context.arc(point.x, point.y, point.radius + glow * 0.7, 0, Math.PI * 2);
      context.fillStyle = point.pink
        ? `rgba(255, 120, 181, ${0.22 + glow * 0.32})`
        : `rgba(97, 116, 255, ${0.19 + glow * 0.3})`;
      context.fill();

      for (let otherIndex = index + 1; otherIndex < particles.length; otherIndex += 1) {
        const other = particles[otherIndex];
        const distance = Math.hypot(point.x - other.x, point.y - other.y);
        if (distance > 120) continue;
        context.beginPath();
        context.moveTo(point.x, point.y);
        context.lineTo(other.x, other.y);
        context.strokeStyle = `rgba(102, 123, 224, ${(1 - distance / 120) * 0.075})`;
        context.lineWidth = 0.55;
        context.stroke();
      }
    }

    if (!reducedMotion) animationFrame = requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  });
  window.addEventListener("pointerleave", () => {
    pointer.x = -1000;
    pointer.y = -1000;
  });
  window.addEventListener("beforeunload", () => cancelAnimationFrame(animationFrame));
  resize();
}

updateEditor();
initAmbientCanvas();
loadHealth();
