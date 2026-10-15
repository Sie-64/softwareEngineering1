/**
 * @file fileTool.js
 * @description 【工具层】`read_file` 工具实现。
 *              设计原则：任何失败都返回以 "ERROR:" 开头的字符串而不是抛异常，
 *              这样 LLM 能把错误当成 Observation 看到，从而自我修正。
 */

import { stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

/** 单个文件允许读取的最大字节数（200 KB）。 */
export const MAX_FILE_BYTES = 200_000;

/**
 * 读取指定文件并返回带行号的内容。
 *
 * 工具函数统一接收「一个对象参数」，字段名与 Prompt 中声明的参数名一致，便于 registry 直接透传。
 *
 * @param {{ file_path?: string }} [args] - 工具参数对象。
 * @param {string} [args.file_path] - 目标文件路径（相对或绝对均可）。
 * @returns {Promise<string>} 带行号的文件内容，或 "ERROR: ..." 错误信息。
 */
export async function readFile({ file_path } = {}) {
  try {
    // 1. 参数校验
    if (typeof file_path !== "string" || file_path.trim() === "") {
      return "ERROR: filePath 必须是非空字符串";
    }

    // 2. 解析为绝对路径（相对路径以进程 CWD 为基准）
    const absolutePath = path.resolve(file_path);

    // 3. 存在性与类型校验
    let stats;
    try {
      stats = await stat(absolutePath);
    } catch {
      return `ERROR: 文件不存在或不是普通文件：${file_path}`;
    }
    if (!stats.isFile()) {
      return `ERROR: 文件不存在或不是普通文件：${file_path}`;
    }

    // 4. 体积校验，防止一次性把超大文件塞进上下文
    if (stats.size > MAX_FILE_BYTES) {
      return `ERROR: 文件过大（${stats.size} 字节），超过限制（${MAX_FILE_BYTES} 字节）。请缩小审查范围或分段读取。`;
    }

    // 5. 读取内容
    const raw = await fsReadFile(absolutePath, "utf-8");

    // 6. 逐行加行号，方便模型在报告中引用具体位置
    const numbered = raw
      .split(/\r?\n/)
      .map((line, index) => `${String(index + 1).padStart(4)} | ${line}`)
      .join("\n");

    return `文件 ${file_path} 内容如下（带行号）：\n${numbered}`;
  } catch (err) {
    return `ERROR: 读取文件失败：${err.message}`;
  }
}
