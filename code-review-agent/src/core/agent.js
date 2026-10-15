/**
 * @file agent.js
 * @description 【核心层】Agent 主循环（ReAct）。
 *              职责：维护记忆 → 调用 LLM → 解析输出 → 调度工具 → 把 Observation 回灌 → 重复，
 *              直到拿到 Final Answer、耗尽最大步数，或 LLM 彻底失败。
 */

import { LLMClient } from "./llmClient.js";
import { Memory } from "./memory.js";
import { SYSTEM_PROMPT, REACT_HINT } from "./prompts.js";
import { callTool } from "../tools/registry.js";

/** 最终答案正则：捕获 Final Answer 之后的全部内容。 */
const FINAL_RE = /Final Answer\s*[:：]\s*([\s\S]+)/;
/** 动作名正则。 */
const ACTION_RE = /Action\s*[:：]\s*(\w+)/;
/** 动作参数正则（非贪婪，从第一个 { 到最近的 }）。 */
const ACTION_INPUT_RE = /Action Input\s*[:：]\s*(\{[\s\S]*?\})/;
/** 动作参数兜底正则（贪婪，用于参数值里含 } 的情况）。 */
const ACTION_INPUT_GREEDY_RE = /Action Input\s*[:：]\s*(\{[\s\S]*\})/;

/** 模型没按格式输出时追加的纠正提示。 */
const FORMAT_CORRECTION_HINT = `你的上一条输出格式不正确。请严格按以下两种格式之一重新输出，不要添加任何多余文字：

格式一（需要调用工具时）：
Thought: 你的推理过程
Action: read_file 或 execute_code
Action Input: {"file_path": "..."} 或 {"code_snippet": "..."}

格式二（信息足够时）：
Thought: 我已经收集到足够信息，可以给出最终审查报告。
Final Answer: 你的完整代码审查报告（Markdown 格式）`;

/**
 * 代码审查 Agent。
 */
export class CodeReviewAgent {
  /**
   * @param {ReturnType<import("../config.js").loadConfig>} config - 全局配置。
   */
  constructor(config) {
    this.config = config;
    this.llm = new LLMClient(config);
    this.memory = new Memory(config);
    // system 消息是所有工具协议与格式约定的来源，一次性写入，之后由 Memory 永久保留。
    this.memory.add("system", SYSTEM_PROMPT);
  }

  /**
   * 对一个用户输入（文件路径 / 代码片段 / 追问）执行完整的 ReAct 审查流程。
   *
   * @param {string} userInput - 用户输入。
   * @returns {Promise<string>} 最终审查报告，或失败/超步提示。
   */
  async review(userInput) {
    this.memory.add("user", userInput);
    this.memory.add("user", REACT_HINT);

    for (let step = 0; step < this.config.maxAgentSteps; step++) {
      let llmOutput;
      try {
        llmOutput = await this.llm.chat(this.memory.get());
      } catch (err) {
        return `LLM 调用失败，无法继续审查：${err.message}`;
      }

      console.debug(`[agent] 第 ${step + 1} 步模型输出：\n${llmOutput}`);
      this.memory.add("assistant", llmOutput);

      // 终止条件 1：拿到最终报告
      const finalAnswer = this._extractFinalAnswer(llmOutput);
      if (finalAnswer) {
        return finalAnswer;
      }

      // 解析 Action
      const parsed = this._parseAction(llmOutput);
      if (!parsed || !parsed.args) {
        // 既没有 Final Answer，也没能解析出可用 Action → 追加纠正提示后重试
        console.warn("[agent] 模型输出不符合 ReAct 格式，已追加纠正提示并要求重试。");
        this.memory.add("user", FORMAT_CORRECTION_HINT);
        continue;
      }

      // 执行工具，并把结果作为 Observation 回灌
      const observation = await callTool(parsed.action, parsed.args);
      console.debug(`[agent] 工具 ${parsed.action} 返回：\n${observation}`);
      this.memory.add("user", `Observation: ${observation}`);
    }

    // 终止条件 2：步数耗尽
    return "已达到最大推理步数，未能生成最终审查报告。请尝试缩小审查范围或提高 AGENT_MAX_STEPS。";
  }

  /**
   * 从模型输出中提取 Final Answer 正文。
   *
   * @private
   * @param {string} text - 模型输出。
   * @returns {string|null} 报告正文；未命中返回 null。
   */
  _extractFinalAnswer(text) {
    const match = text.match(FINAL_RE);
    if (!match) return null;
    const answer = match[1].trim();
    return answer === "" ? null : answer;
  }

  /**
   * 解析模型输出中的 Action 与 Action Input。
   *
   * @private
   * @param {string} text - 模型输出。
   * @returns {{ action: string, args: Record<string, any>|null }|null}
   *          解析结果；没有 Action 时返回 null，Action 存在但参数不合法时 args 为 null。
   */
  _parseAction(text) {
    const actionMatch = text.match(ACTION_RE);
    if (!actionMatch) return null;
    const action = actionMatch[1];

    // 收集候选 JSON 片段：先用约定的非贪婪正则，再用贪婪正则兜底
    const candidates = [];
    const lazyMatch = text.match(ACTION_INPUT_RE);
    if (lazyMatch) candidates.push(lazyMatch[1]);
    const greedyMatch = text.match(ACTION_INPUT_GREEDY_RE);
    if (greedyMatch && greedyMatch[1] !== lazyMatch?.[1]) candidates.push(greedyMatch[1]);

    for (const raw of candidates) {
      const args = this._tryParseJson(raw);
      if (args) return { action, args };
    }

    if (candidates.length === 0) {
      console.warn("[agent] 模型给出了 Action 但缺少 Action Input。");
    } else {
      console.warn("[agent] Action Input 不是合法 JSON，已放弃该步。");
      console.debug(`[agent] 原始 Action Input：${candidates[0]}`);
    }
    return { action, args: null };
  }

  /**
   * 容错地把字符串解析为 JSON 对象。
   *
   * 依次尝试：直接解析 → 修掉尾随逗号 / 单引号 / 缺失右括号后再解析。
   *
   * @private
   * @param {string} raw - 待解析的 JSON 片段。
   * @returns {Record<string, any>|null} 解析出的对象；失败返回 null。
   */
  _tryParseJson(raw) {
    const attempts = [raw, this._repairJson(raw)];
    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // 继续尝试下一种修复方式
      }
    }
    return null;
  }

  /**
   * 对畸形 JSON 做最小化修复。
   *
   * @private
   * @param {string} raw - 原始片段。
   * @returns {string} 修复后的片段。
   */
  _repairJson(raw) {
    let text = raw.trim();
    // 去掉对象/数组末尾的多余逗号
    text = text.replace(/,\s*([}\]])/g, "$1");
    // 模型用单引号时，统一替换为双引号
    if (!text.includes('"')) {
      text = text.replace(/'/g, '"');
    }
    // 补全缺失的右花括号
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) {
      text += "}";
    }
    return text;
  }
}
