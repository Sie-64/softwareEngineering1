/**
 * @file codeTool.js
 * @description 【工具层】`execute_code` 工具实现——用 Node 内置 `node:vm` 执行一小段 JS。
 *              用途是让 Agent 「动手验证」：例如跑一遍除零、空数组求平均，观察真实输出再下结论。
 *
 * ⚠️ 安全声明：`node:vm` 并不是安全边界，它只做上下文隔离，恶意代码仍可能逃逸。
 *              本实现通过「黑名单 + 代码长度限制 + 执行超时 + 关闭代码生成」降低风险，
 *              生产环境请改用 `worker_threads` + 超时，或独立进程 / Docker 容器隔离。
 */

import vm from "node:vm";

/** 允许执行的代码最大字符数，防止把整个项目塞进来执行。 */
export const MAX_CODE_CHARS = 20_000;

/** 单次执行的最长毫秒数，防止死循环卡死进程。 */
export const EXEC_TIMEOUT_MS = 5_000;

/** 危险操作黑名单：命中任意一项直接拒绝执行。 */
export const CODE_BLACKLIST = [
  "require(",
  "process.exit",
  "child_process",
  "fs.unlink",
  "fs.rmdir",
  "fs.rm(",
];

/**
 * 把任意值格式化成一行可读文本，用于收集 console 输出。
 *
 * @param {any} value - 任意值。
 * @returns {string} 文本表示。
 */
function formatValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 在 `node:vm` 沙箱中执行一段 JavaScript 代码并回收其输出。
 *
 * 工具函数统一接收「一个对象参数」，字段名与 Prompt 中声明的参数名一致。
 *
 * @param {{ code_snippet?: string }} [args] - 工具参数对象。
 * @param {string} [args.code_snippet] - 待执行的 JavaScript 代码片段。
 * @returns {Promise<string>} 执行结果 / 标准输出 / 标准错误，或 "ERROR: ..." 错误信息。
 */
export async function executeCode({ code_snippet } = {}) {
  try {
    // 1. 参数校验
    if (typeof code_snippet !== "string" || code_snippet.trim() === "") {
      return "ERROR: code_snippet 必须是非空字符串";
    }
    if (code_snippet.length > MAX_CODE_CHARS) {
      return `ERROR: 代码过长（${code_snippet.length} 字符），超过限制（${MAX_CODE_CHARS} 字符）。请只提交需要验证的最小片段。`;
    }

    // 2. 黑名单校验
    const hit = CODE_BLACKLIST.find((keyword) => code_snippet.includes(keyword));
    if (hit) {
      return `ERROR: 代码包含被禁止的操作：${hit}`;
    }

    // 3. 构造沙箱：console 重定向 + result 回传口
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const pushStdout = (...args) => stdout.push(args.map(formatValue).join(" "));
    const pushStderr = (...args) => stderr.push(args.map(formatValue).join(" "));

    const sandbox = {
      console: {
        log: pushStdout,
        info: pushStdout,
        debug: pushStdout,
        warn: pushStderr,
        error: pushStderr,
      },
      // 用户把最终结果赋值给 result，即可通过 context.result 取回
      result: undefined,
    };

    // codeGeneration 关闭字符串/WASM 动态代码生成，削弱 eval / new Function 逃逸面
    const context = vm.createContext(sandbox, {
      name: "code-review-agent-sandbox",
      codeGeneration: { strings: false, wasm: false },
    });

    // 4. 编译并执行（编译期语法错误也会在这里被捕获）
    let thrown = null;
    try {
      const script = new vm.Script(code_snippet, { filename: "snippet.js" });
      script.runInContext(context, { timeout: EXEC_TIMEOUT_MS, displayErrors: true });
    } catch (err) {
      thrown = err;
    }

    // 5. 汇总输出
    const parts = [];

    if (thrown) {
      parts.push(`代码执行抛出异常：\n${thrown.stack ?? String(thrown)}`);
    } else {
      parts.push("代码执行成功。");
    }

    if (stdout.length > 0) {
      parts.push(`标准输出：\n${stdout.join("\n")}`);
    }
    if (stderr.length > 0) {
      parts.push(`标准错误：\n${stderr.join("\n")}`);
    }
    if (!thrown && stdout.length === 0 && stderr.length === 0) {
      parts.push("代码执行成功，无输出。");
    }

    // 6. 若用户给 result 赋过值，则附加返回值
    if (typeof context.result !== "undefined") {
      parts.push(`返回值：${formatValue(context.result)}`);
    }

    return parts.join("\n\n");
  } catch (err) {
    return `ERROR: 代码执行失败：${err.message}`;
  }
}
