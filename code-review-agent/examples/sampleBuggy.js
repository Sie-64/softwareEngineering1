/**
 * @file sampleBuggy.js
 * @description 示例「问题代码」，供 Agent 审查演示用。请勿直接运行。
 *
 * 说明：本文件刻意保留 CommonJS 的 module.exports 写法，用于演示
 *      execute_code 的 require( 黑名单会被命中（Agent 若试图 require 本文件会被拒绝）。
 *      这并不代表 Agent 只支持 CommonJS——被审查对象可以是任意语言的代码文本。
 */

// 1. 除零风险
function divide(a, b) {
  return a / b; // b 为 0 时返回 Infinity，未处理
}

// 2. 数组越界
function getItem(arr, index) {
  return arr[index]; // 越界返回 undefined，未校验
}

// 3. 空数组求平均 → 除零
function average(nums) {
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

// 4. 未处理 null / undefined
function getLength(str) {
  return str.length; // str 为 null 时报错
}

// 5. 异步未捕获
async function fetchData(url) {
  const res = await fetch(url); // 未 try/catch，网络失败会抛未捕获
  return res.json();
}

module.exports = { divide, getItem, average, getLength, fetchData };
