/**
 * @file memory.js
 * @description 【核心层】对话记忆。
 *              用最朴素的数组保存 `{ role, content }` 消息，并在每次写入后做裁剪，
 *              防止 ReAct 循环越跑越长导致上下文超限 / Token 成本失控。
 */

/**
 * @typedef {{ role: "system"|"user"|"assistant", content: string }} ChatMessage
 */

/**
 * 对话记忆容器。
 *
 * 设计取舍：
 * - 用数组而非向量库：ReAct 需要严格保序的完整上下文，向量检索反而会打乱推理链条；
 * - 用「滑动窗口」而不是摘要压缩：实现简单、行为可预测，代价是早期细节会丢失。
 */
export class Memory {
  /**
   * @param {ReturnType<import("../config.js").loadConfig>} config - 全局配置。
   */
  constructor(config) {
    /** @type {ChatMessage[]} 完整的消息序列（system 消息始终位于头部）。 */
    this.messages = [];
    /** @type {number} 保留的最大对话轮数（1 轮 ≈ user + assistant）。 */
    this.maxMemoryTurns = config.maxMemoryTurns;
  }

  /**
   * 追加一条消息，并在追加后立即触发裁剪。
   *
   * @param {"system"|"user"|"assistant"} role - 消息角色。
   * @param {string} content - 消息正文。
   * @returns {void}
   */
  add(role, content) {
    this.messages.push({ role, content });
    this._trim();
  }

  /**
   * 裁剪历史：永久保留所有 system 消息，其余消息只保留最近 `maxMemoryTurns * 2` 条。
   *
   * 保留 system 是必须的——它是工具协议与输出格式的唯一来源，丢失后模型会立刻「失忆」。
   *
   * @private
   * @returns {void}
   */
  _trim() {
    const systemMessages = this.messages.filter((m) => m.role === "system");
    const otherMessages = this.messages.filter((m) => m.role !== "system");

    const limit = this.maxMemoryTurns * 2;
    const trimmedOthers =
      otherMessages.length > limit ? otherMessages.slice(-limit) : otherMessages;

    this.messages = [...systemMessages, ...trimmedOthers];
  }

  /**
   * 获取当前消息列表的浅拷贝，避免调用方意外篡改内部数组。
   *
   * @returns {ChatMessage[]} 消息列表副本。
   */
  get() {
    return this.messages.slice();
  }

  /**
   * 清空全部记忆（包括 system 消息）。
   *
   * @returns {void}
   */
  clear() {
    this.messages = [];
  }
}
