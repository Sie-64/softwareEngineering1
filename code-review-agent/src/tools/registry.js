/**
 * @file registry.js
 * @description 【工具层】工具注册表 + 统一调度入口。
 *              Agent 只认识「工具名 + 参数对象」，具体实现由注册表决定，
 *              新增工具时只需在这里注册一行，符合开闭原则。
 */

import { readFile } from "./fileTool.js";
import { executeCode } from "./codeTool.js";

/**
 * 工具注册表：键为 Prompt 中声明的工具名，值为对应实现函数。
 *
 * 约定：所有工具函数都接收「一个对象参数」，字段名与 Prompt 中一致。
 *
 * @type {Record<string, (args: any) => Promise<string>|string>}
 */
export const TOOL_REGISTRY = {
  read_file: readFile,
  execute_code: executeCode,
};

/**
 * 按名称调用工具，并把一切异常转成 "ERROR: ..." 字符串。
 *
 * 之所以不向上抛异常：工具错误需要作为 Observation 回灌给 LLM，让它自我修正，
 * 而不是直接打断整个 Agent 循环。
 *
 * @param {string} name - 工具名。
 * @param {Record<string, any>} [args] - 工具参数对象。
 * @returns {Promise<string>} 工具执行结果或 "ERROR: ..." 错误信息。
 */
export async function callTool(name, args = {}) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) {
    return `ERROR: 未知工具 ${name}，可用工具：${Object.keys(TOOL_REGISTRY).join(", ")}`;
  }

  try {
    const safeArgs = args && typeof args === "object" ? args : {};
    const result = await TOOL_REGISTRY[name](safeArgs);
    return typeof result === "string" ? result : String(result);
  } catch (err) {
    return `ERROR: 工具 ${name} 执行失败：${err.message}`;
  }
}

/**
 * 返回可用工具名列表，供 CLI 展示或调试使用。
 *
 * @returns {string[]} 工具名数组。
 */
export function listTools() {
  return Object.keys(TOOL_REGISTRY);
}
