/**
 * @file config.js
 * @description 【配置层】集中读取并校验环境变量，向其余各层提供统一的配置对象。
 *              所有环境变量的默认值、类型转换都收敛在本文件，避免散落在业务代码里。
 */

import dotenv from "dotenv";

// 尽早加载 .env，使后续 process.env 能读到用户配置。
dotenv.config();

/**
 * 将环境变量解析为整数，非法值回退到默认值。
 *
 * @param {string|undefined} raw - 原始环境变量值。
 * @param {number} fallback - 解析失败时使用的默认值。
 * @returns {number} 解析后的数字。
 */
function toNumber(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 读取环境变量并生成 Agent 运行所需的完整配置对象。
 *
 * @returns {{
 *   apiKey: string,
 *   baseURL: string,
 *   model: string,
 *   timeout: number,
 *   maxRetries: number,
 *   maxAgentSteps: number,
 *   maxMemoryTurns: number
 * }} 配置对象。
 */
export function loadConfig() {
  return {
    // 认证信息
    apiKey: process.env.OPENAI_API_KEY || "",
    // 接口地址，可指向任意 OpenAI 兼容服务（DeepSeek / 通义千问 / Kimi 等）
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    // 模型名
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",

    // 单次请求超时（毫秒）
    timeout: toNumber(process.env.LLM_TIMEOUT, 60_000),
    // 单次请求最大重试次数
    maxRetries: toNumber(process.env.LLM_MAX_RETRIES, 3),
    // Agent 最大 ReAct 步数
    maxAgentSteps: toNumber(process.env.AGENT_MAX_STEPS, 8),
    // 记忆保留的最大对话轮数
    maxMemoryTurns: toNumber(process.env.AGENT_MAX_MEMORY_TURNS, 10),
  };
}

/**
 * 校验配置对象的合法性，配置缺失时直接抛错，交由 CLI 层统一处理退出。
 *
 * @param {ReturnType<typeof loadConfig>} config - 待校验的配置对象。
 * @throws {Error} 当 apiKey 为空或关键数值非法时抛出。
 * @returns {void}
 */
export function validateConfig(config) {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error(
      "缺少 OPENAI_API_KEY。请在项目根目录创建 .env（可复制 .env.example）并填入你的 API Key。",
    );
  }

  // 常见坑：执行过 `cp .env.example .env` 但忘了替换占位符，
  // 结果会在调用模型时收到 401，报错信息完全看不出根因。这里提前拦截。
  const trimmedKey = config.apiKey.trim().toLowerCase();
  const placeholders = ["your_api_key_here", "your_api_key", "sk-xxx", "sk-your-key", "api_key"];
  if (placeholders.includes(trimmedKey)) {
    throw new Error(
      `OPENAI_API_KEY 仍是模板占位符（${config.apiKey.trim()}）。请打开 .env 把 Key 替换为真实值——` +
        "若你之前已配置好，注意不要再用 `cp .env.example .env` 覆盖它。",
    );
  }

  if (!Number.isFinite(config.maxAgentSteps) || config.maxAgentSteps < 1) {
    throw new Error("AGENT_MAX_STEPS 必须是不小于 1 的整数。");
  }

  if (!Number.isFinite(config.maxRetries) || config.maxRetries < 1) {
    throw new Error("LLM_MAX_RETRIES 必须是不小于 1 的整数。");
  }
}
