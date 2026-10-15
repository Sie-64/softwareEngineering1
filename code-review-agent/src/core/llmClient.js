/**
 * @file llmClient.js
 * @description 【核心层】LLM 调用封装。
 *              对外只暴露一个 `chat()`，把 SDK 细节、超时、重试、退避全部收敛在这里，
 *              让 Agent 主循环不必关心网络抖动。
 */

import OpenAI, { APIConnectionError, APIConnectionTimeoutError } from "openai";

/**
 * 常见的可重试网络错误码（DNS 解析失败、连接被拒/重置、超时等）。
 * undici 会把真实原因放在 err.cause.code 上，因此需要一并检查。
 */
const RETRYABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Promise 化的 sleep。
 *
 * @param {number} ms - 休眠毫秒数。
 * @returns {Promise<void>} 定时结束后 resolve。
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试：请求超时、连接错误、429 限流、5xx 服务端错误。
 * 不可重试：401/403 鉴权失败、400 参数错误等——重试只是浪费时间，最多再给一次机会。
 *
 * @param {any} err - 捕获到的异常对象。
 * @returns {{retryable: boolean, reason: string}} 判定结果及原因说明。
 */
function classifyError(err) {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code ?? err?.cause?.code ?? err?.cause?.cause?.code ?? "";
  const message = `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;

  // 优先用 instanceof 判定。
  // 注意：openai SDK 4.x 的 APIConnectionError 并不会设置 err.name（实测为 "Error"），
  // 只按 name 判断会把「断网 / DNS 失败」误判成不可重试，因此实例判定是必须的。
  // APIConnectionTimeoutError 是 APIConnectionError 的子类，必须先判子类。
  if (err instanceof APIConnectionTimeoutError) {
    return { retryable: true, reason: "请求超时" };
  }
  if (err instanceof APIConnectionError) {
    return { retryable: true, reason: "网络连接错误" };
  }

  // 其次是错误码（覆盖 undici / 系统层面的网络异常）
  if (RETRYABLE_CODES.has(code)) {
    return { retryable: true, reason: `网络错误（${code}）` };
  }

  // 最后是文本兜底，兼容不同 SDK 版本的措辞
  if (/timed?\s*out|timeout/i.test(message)) {
    return { retryable: true, reason: "请求超时" };
  }
  if (/connection error|fetch failed|socket hang up|getaddrinfo|network/i.test(message)) {
    return { retryable: true, reason: "网络连接错误" };
  }
  if (status === 429 || /429|rate\s*limit|too many requests|限流|速率/i.test(message)) {
    return { retryable: true, reason: "限流（429）" };
  }
  if (typeof status === "number" && status >= 500) {
    return { retryable: true, reason: `服务端错误（${status}）` };
  }

  return { retryable: false, reason: status ? `客户端错误（${status}）` : "未知错误" };
}

/**
 * 对 OpenAI 兼容接口的最小封装。
 */
export class LLMClient {
  /**
   * @param {ReturnType<import("../config.js").loadConfig>} config - 全局配置。
   */
  constructor(config) {
    this.model = config.model;
    this.maxRetries = config.maxRetries;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout,
      // 重试逻辑由本类自己实现（含指数退避与日志），故关闭 SDK 内建重试，避免重复叠加。
      maxRetries: 0,
    });
  }

  /**
   * 发起一次对话补全请求，失败时按策略重试。
   *
   * @param {Array<{role: string, content: string}>} messages - 完整消息列表。
   * @param {number} [temperature=0.2] - 采样温度。代码审查需要稳定格式，默认取较低值。
   * @throws {Error} 当所有重试均失败时抛出，消息中包含最后一次的错误原因。
   * @returns {Promise<string>} 模型返回的文本内容（已 trim）。
   */
  async chat(messages, temperature = 0.2) {
    let lastError = null;
    /** 非重试类错误额外给一次机会，用这个计数器限制，避免无意义循环。 */
    let toleratedFailureUsed = false;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const humanAttempt = attempt + 1;
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          temperature,
        });

        const content = response?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw new Error("LLM 返回了空内容");
        }
        return content.trim();
      } catch (err) {
        lastError = err;
        const { retryable, reason } = classifyError(err);
        const hasNextAttempt = humanAttempt < this.maxRetries;

        if (retryable) {
          if (!hasNextAttempt) break;
          // 指数退避：2^attempt 秒（1s → 2s → 4s ...）
          const delayMs = 2 ** attempt * 1000;
          console.warn(
            `[llmClient] 第 ${humanAttempt}/${this.maxRetries} 次调用失败（${reason}）：${err.message}；${delayMs}ms 后重试。`,
          );
          await sleep(delayMs);
          continue;
        }

        // 非重试类错误（鉴权/参数等）：记录日志，最多再试一次。
        if (!toleratedFailureUsed && hasNextAttempt) {
          toleratedFailureUsed = true;
          console.error(
            `[llmClient] 调用出错（${reason}，非重试类）：${err.message}；再重试一次。`,
          );
          continue;
        }

        console.error(`[llmClient] 调用出错（${reason}），不再重试：${err.message}`);
        break;
      }
    }

    // 汇总最后一次错误的可诊断信息：HTTP 状态码与服务端/网络错误码对排查至关重要
    const status = lastError?.status;
    const code = lastError?.code ?? lastError?.cause?.code;
    const detail = [
      lastError?.message ?? "未知错误",
      status ? `status=${status}` : null,
      code ? `code=${code}` : null,
    ]
      .filter(Boolean)
      .join("，");

    // 用 cause 保留原始错误对象，避免堆栈信息丢失
    throw new Error(`LLM 调用失败（最多重试 ${this.maxRetries} 次）：${detail}`, {
      cause: lastError,
    });
  }
}
