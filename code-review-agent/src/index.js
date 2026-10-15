/**
 * @file index.js
 * @description 【入口层】CLI 入口 + 交互循环。
 *              只负责「收集输入 / 展示输出 / 捕获顶层异常」，所有业务逻辑都下沉到 core 与 tools。
 */

import { Command } from "commander";
import * as readline from "node:readline/promises";
import chalk from "chalk";

import { loadConfig, validateConfig } from "./config.js";
import { CodeReviewAgent } from "./core/agent.js";
import { listTools } from "./tools/registry.js";

/**
 * 统一输出函数（走 stdout，避免与调试日志混在一起）。
 *
 * @param {string} text - 待输出文本。
 * @returns {void}
 */
function out(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * 解析命令行参数。
 *
 * @returns {{ file?: string, code?: string, verbose?: boolean }} 命令行选项。
 */
function parseArgs() {
  const program = new Command();

  program
    .name("code-review-agent")
    .description("基于 ReAct 循环的代码审查 Agent：分析代码质量、发现潜在 Bug、给出改进建议。")
    .version("1.0.0")
    .option("-f, --file <path>", "待审查的代码文件路径")
    .option("-c, --code <code>", "直接传入待审查的代码字符串")
    .option("-v, --verbose", "输出调试日志（ReAct 每一步的原始输出）")
    .showHelpAfterError("（可用 --help 查看全部用法）");

  program.parse(process.argv);
  return program.opts();
}

/**
 * 根据命令行参数构造首轮用户输入。
 *
 * @param {{ file?: string, code?: string }} options - 命令行选项。
 * @returns {string|null} 首轮输入；未提供 --file / --code 时返回 null。
 */
function buildInitialInput({ file, code }) {
  if (file) {
    return `请审查文件：${file}。请先使用 read_file 工具读取该文件，然后进行分析。`;
  }
  if (code) {
    return `请审查以下代码：\n\`\`\`javascript\n${code}\n\`\`\``;
  }
  return null;
}

/**
 * 展示审查报告。
 *
 * @param {string} report - Agent 返回的 Markdown 报告。
 * @returns {void}
 */
function printReport(report) {
  out(chalk.cyan("\n──────────── 审查报告 ────────────\n"));
  out(chalk.cyan(report));
  out(chalk.cyan("\n──────────────────────────────────"));
}

/**
 * 纯寒暄 / 无信息量输入的匹配规则。
 *
 * 只匹配「整个输入就是一句问候或客套话」这种最窄的情况——不包含代码、路径或任何实质内容，
 * 目的是避免用户随手敲一句「你好」就被重跑一遍完整审查（既费 token 又显得答非所问）。
 */
const SMALL_TALK_RE =
  /^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在么|谢谢|多谢|感谢|thanks|thank you|thx|ok|okay|好的|好呢|收到|明白|嗯|嗯嗯|是|对)$/i;

/**
 * 判断输入是否只是寒暄，命中时可本地回应，不必调用 LLM。
 *
 * @param {string} input - 已 trim 的用户输入。
 * @returns {boolean} 是否属于纯寒暄。
 */
function isSmallTalk(input) {
  return input.length > 0 && input.length <= 12 && SMALL_TALK_RE.test(input);
}

/**
 * 打印寒暄场景的本地回应，并提示用户如何提供审查对象。
 *
 * @returns {void}
 */
function printSmallTalkReply() {
  out(chalk.cyan("我在。把要审查的东西发给我就行——文件路径或一段代码都可以，例如："));
  out(chalk.gray("  examples/sampleBuggy.js"));
  out(chalk.gray("  function divide(a, b) { return a / b; }"));
  out(chalk.gray('也可以在启动时直接指定：npm start -- --file <路径> 或 --code "<代码>"'));
}

/**
 * 进入多轮交互模式，直到用户输入 exit/quit/q 或标准输入关闭。
 *
 * @param {CodeReviewAgent} agent - 已就绪的 Agent 实例。
 * @returns {Promise<void>} 交互结束后的 Promise。
 */
async function runInteractiveLoop(agent) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  out(chalk.gray("输入要审查的代码 / 文件路径，输入 exit 退出。\n"));

  while (!closed) {
    let input;
    try {
      input = await rl.question(chalk.yellow("你："));
    } catch {
      // 标准输入已关闭（例如管道输入结束）
      break;
    }

    const trimmed = input.trim();
    if (["exit", "quit", "q"].includes(trimmed.toLowerCase())) {
      out(chalk.gray("再见！"));
      break;
    }
    if (trimmed === "") {
      continue;
    }

    // 纯寒暄直接本地回应，避免重复触发上一轮审查
    if (isSmallTalk(trimmed)) {
      printSmallTalkReply();
      continue;
    }

    const report = await agent.review(trimmed);
    printReport(report);
  }

  rl.close();
}

/**
 * 程序主流程。
 *
 * @returns {Promise<void>} 流程结束后的 Promise。
 */
async function main() {
  const options = parseArgs();

  // 非 verbose 模式下关闭 console.debug，避免调试日志污染标准输出
  if (!options.verbose) {
    console.debug = () => {};
  }

  let config;
  try {
    config = loadConfig();
    validateConfig(config);
  } catch (err) {
    out(chalk.red(`✖ 配置错误：${err.message}`));
    process.exit(1);
  }

  const agent = new CodeReviewAgent(config);

  out(chalk.bold("\n🔍 Code Review Agent"));
  out(
    chalk.gray(
      `模型：${config.model} ｜ 接口：${config.baseURL} ｜ 可用工具：${listTools().join(", ")}\n`,
    ),
  );

  const initialInput = buildInitialInput(options);
  if (initialInput) {
    out(chalk.gray("正在审查，请稍候..."));
    const report = await agent.review(initialInput);
    printReport(report);
  }

  await runInteractiveLoop(agent);
}

main().catch((err) => {
  out(chalk.red(`✖ 发生未预期的错误：${err?.stack ?? err?.message ?? err}`));
  process.exit(1);
});
