# 代码审查 Agent —— 设计文档

> 路径约定：文中出现的 `src/...`、`examples/...` 均相对于项目目录 `code-review-agent/`。

## 1. 项目目标

### 1.1 作业要求

| 要求 | 本项目的实现方式 |
|---|---|
| 实现基本 Agent 循环：输入 → 推理 → 工具调用 → 输出 | `src/core/agent.js` 手写 ReAct 循环 |
| 支持至少一种工具 | 提供 `read_file` 与 `execute_code` 两个工具 |
| 可通过命令行交互 | `src/index.js` 基于 commander + `readline/promises` |
| 使用 LLM 原生 API（OpenAI 兼容） | `src/core/llmClient.js` 基于官方 `openai` SDK，`baseURL` 可切换 |
| 支持上下文记忆（多轮对话） | `src/core/memory.js` 数组记忆 + 滑动窗口裁剪 |
| 包含错误处理与重试 | LLM 层指数退避重试；工具层错误字符串化；入口层兜底 |

### 1.2 为什么选「代码审查」方向

代码审查天然是一个**需要动手**的任务，能最大化体现工具调用的价值：

1. **必须读文件**：代码通常不在提示词里，Agent 必须主动调用 `read_file`，否则只能凭空猜测——这是最能体现「工具是 Agent 的手」的场景。
2. **可以动手验证**：判断「空数组求平均会怎样」这类问题，跑一遍比空想更可靠，`execute_code` 因此有明确用途。
3. **结果结构化**：审查报告有固定的结构（总体评价 / 问题清单 / 修复建议），便于用 Prompt 约束并通过正则校验格式，是练 ReAct 解析的理想载体。
4. **容易评估**：`examples/sampleBuggy.js` 内置了除零、越界、空数组、空值解引用、未捕获异步等典型 Bug，可以直接检验 Agent 是否真的发现了问题。

## 2. 总体架构

采用**四层分离**，核心思想是「推理与执行分离」：核心层只负责「想」，工具层只负责「做」，二者通过统一协议通信。

```
┌─────────────────────────────────────────────────┐
│  入口层 (src/index.js)                           │
│  接收用户输入、展示结果、交互循环                  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  核心层 (src/core/)                              │
│  ┌──────────────┐  ┌────────────────┐           │
│  │  agent.js    │  │ llmClient.js   │           │
│  │  ReAct 循环  │──│  LLM 调用+重试  │           │
│  └──────┬───────┘  └────────────────┘           │
│         │  ┌──────────────┐  ┌──────────────┐   │
│         │──│  memory.js   │  │ prompts.js   │   │
│         │  │  对话记忆     │  │  Prompt 模板 │   │
│         │  └──────────────┘  └──────────────┘   │
└─────────┼───────────────────────────────────────┘
          │ 工具调用
┌─────────▼───────────────────────────────────────┐
│  工具层 (src/tools/)                             │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ fileTool.js  │  │ codeTool.js  │             │
│  │  read_file   │  │ execute_code │             │
│  └──────┬───────┘  └──────┬───────┘             │
│         └────────┬────────┘                     │
│            ┌─────▼──────┐                       │
│            │ registry.js│  注册表 + 统一调度     │
│            └────────────┘                       │
└─────────────────────────────────────────────────┘
```

各层职责与设计约束：

| 层 | 职责 | 设计约束 |
|---|---|---|
| 入口层 | 参数解析、交互、输出 | 不含业务逻辑；只做「收集 → 调用 → 展示」 |
| 核心层 | 编排推理与工具调用 | 不关心工具内部实现，只认工具名与参数对象 |
| 工具层 | 执行读文件 / 跑代码 | 不抛异常给上层，一律返回 `ERROR:` 字符串 |
| 配置层 | 环境变量 | 默认值集中管理，`validateConfig` 做启动期校验 |

这种分层的直接收益：新增一个工具只需在 `registry.js` 注册一行；把 ReAct 换成 function calling 只需改 `agent.js`；换模型只需改 `.env`。

## 3. Agent 循环设计

### 3.1 ReAct 模式

ReAct = **Reasoning + Acting**，让模型把「推理」和「行动」交替输出：

- **Thought**：模型的推理过程（不给外部看，但会留在上下文里，起「草稿纸」作用）；
- **Action / Action Input**：模型决定调用哪个工具、传什么参数；
- **Observation**：工具真实返回的结果，由 Agent 追加到上下文，供模型下一轮思考。

选择 ReAct 而不是黑盒式的 function calling，是为了**逻辑透明**：每一步 Thought 都可见，调试时能直接看出模型在哪一步想偏了；这对教学型作业比性能更重要。

### 3.2 单步时序

```
Memory: [system, user(input), user(REACT_HINT)]
   │
   ├─▶ llmClient.chat(messages)  ─── 失败重试(指数退避) ──┐
   │                                                      │
   ◀── 模型输出文本 ◀────────────────────────────────────┘
   │
   ├─ 解析 Final Answer? ── 是 ──▶ 返回报告（循环结束）
   │
   ├─ 解析 Action?
   │     ├─ 缺失 / 参数非法 ──▶ Memory += 格式纠正提示 ──▶ 下一轮
   │     └─ 合法 ──▶ registry.callTool(name, args)
   │                     │
   │                     ◀── Observation 字符串
   │                     ▼
   └─▶ Memory += "Observation: ..." ──▶ 下一轮
```

### 3.3 循环终止条件

| # | 条件 | 实现位置 | 返回内容 |
|---|---|---|---|
| 1 | 输出包含 `Final Answer:` | `_extractFinalAnswer` 命中 | 报告正文 |
| 2 | 达到 `AGENT_MAX_STEPS` | `for` 循环自然结束 | 「已达到最大推理步数…」提示 |
| 3 | LLM 调用彻底失败 | `chat()` 抛错，被 `review()` 捕获 | 「LLM 调用失败，无法继续审查：…」 |

**为什么要设最大步数**：LLM 可能陷入「反复调用同一个工具」的循环，或因格式问题无限纠正。硬性上限是最简单可靠的熔断手段。

## 4. Prompt 设计

### 4.1 System Prompt 全文

```
你是一名资深代码审查专家（Code Review Agent），擅长发现代码中的潜在 Bug、边界问题、安全隐患与可维护性缺陷，并给出可落地的修复建议。

# 你的工作方式
你采用 ReAct（Thought → Action → Observation）模式工作：先思考，再决定是否调用工具获取信息；拿到工具返回结果后继续思考，直到掌握足够信息，再输出最终审查报告。

# 可用工具
1. read_file(file_path: string)
   - 读取指定路径的文件内容，返回带行号的文本。
   - 当审查对象是一个文件路径时，必须先调用本工具读取内容，不要凭空猜测文件内容。

2. execute_code(code_snippet: string)
   - 在受控沙箱中执行一段 JavaScript 代码，用于验证行为、复现问题（例如验证除零、空数组求平均、越界访问的实际结果）。
   - 沙箱内提供 console，可通过 console.log 输出验证过程。
   - 代码中禁止使用 require(、process.exit、child_process、fs.unlink、fs.rmdir、fs.rm 等危险操作。
   - 若想把结果回传，请把最终值赋给变量 result。

# 强制输出格式（必须严格遵守）
你的每一次回复都必须严格使用下面的格式，不要输出任何多余的解释、寒暄，也不要用 Markdown 代码围栏包裹：

Thought: 你的推理过程
Action: 工具名
Action Input: {"参数名": "参数值"}

（工具执行后收到 Observation，可继续下一轮 Thought/Action）

当你认为信息足够时，必须输出：

Thought: 我已经收集到足够信息，可以给出最终审查报告。
Final Answer: 你的完整代码审查报告（Markdown 格式）

# 规则
- Action 的名称必须是 read_file 或 execute_code 之一。
- Action Input 必须是合法 JSON 对象，字段名必须与工具参数名完全一致（file_path 或 code_snippet）。
- 一次只输出一个 Action；发出 Action 后立即停止输出，等待 Observation。
- 收到 Observation 后，若其中包含以 "ERROR:" 开头的错误信息，请自行调整策略（例如换一个路径、缩小审查范围、改写被禁止的代码），不要重复执行同样的错误动作。
- 只有当你认为信息足够时，才输出 Final Answer。

# Final Answer 报告结构要求
报告必须使用 Markdown，并包含以下部分：
1. 总体评价：概述这段代码的质量、主要风险与整体建议。
2. 问题清单：按严重程度从高到低排序，分为【高】【中】【低】三档。每个问题必须包含：
   - 位置（函数名或行号）
   - 问题描述
   - 触发原因 / 复现条件
   - 修复建议
3. 可选修复代码片段：针对高优先级问题给出修正后的代码。

只输出上述格式内容。
```

### 4.2 为什么强调格式

因为 **Agent 的解析完全依赖固定格式**。本项目用三条正则抽取模型意图：

```js
const FINAL_RE = /Final Answer\s*[:：]\s*([\s\S]+)/;
const ACTION_RE = /Action\s*[:：]\s*(\w+)/;
const ACTION_INPUT_RE = /Action Input\s*[:：]\s*(\{[\s\S]*?\})/;
```

格式一旦漂移（比如写成 `Action: read_file(file_path=...)`，或把 Action Input 写成 YAML），正则就会失配。因此 Prompt 中必须做到三件事：

1. **给出可照抄的模板**，而不是抽象描述「请用 ReAct 格式」；
2. **明确禁止项**（不要寒暄、不要用代码围栏包裹 Action）；
3. **用「必须」这类强约束措辞**，并配合较低 `temperature = 0.2` 降低随机性。

### 4.3 格式错误时的纠正策略

不依赖「模型不会再错」，而是分层兜底：

| 层级 | 策略 |
|---|---|
| Prompt 层 | `REACT_HINT` 在每轮用户输入后重申格式，起「考前提醒」作用 |
| 解析层 | `_tryParseJson` 容错：直接 `JSON.parse` → 去尾随逗号 / 单引号转双引号 / 补全右花括号 → 仍失败才放弃；`Action Input` 先用约定的非贪婪正则，再用贪婪正则兜底（参数值里含 `}` 时更稳） |
| 循环层 | 解析失败时追加 `FORMAT_CORRECTION_HINT`（把两种合法格式再贴一遍）并 `continue`，给模型一次纠正机会 |
| 配置层 | 若模型长期不守格式，可降低 `temperature` 或更换模型 |

## 5. 工具集成

### 5.1 工具协议

所有工具遵守同一条契约，三个要素缺一不可：

1. **名称固定**：`read_file` / `execute_code`，与 Prompt 中声明完全一致；
2. **参数为对象**：统一接收一个对象，字段名与 Prompt 中一致，由 `registry.callTool(name, args)` 直接透传；
3. **错误字符串化**：任何失败都返回 `"ERROR: ..."`，绝不向 Agent 抛异常。

```js
// 工具签名
export async function readFile({ file_path }) { ... }
export async function executeCode({ code_snippet }) { ... }

// 注册与调度
export const TOOL_REGISTRY = { read_file: readFile, execute_code: executeCode };
export async function callTool(name, args) { ... }
```

**为什么参数用对象而不是位置参数**：位置参数一旦顺序变化就是静默错误；对象参数按字段名取值，模型少传字段时得到 `undefined` 并触发参数校验，错误是可观测的。

**为什么工具不抛异常**：抛异常会打断 Agent 循环，模型根本没有机会知道「发生了什么」。把错误变成 Observation，模型可以自我修正——例如文件不存在时改为读取正确路径，或换个文件名重试。

### 5.2 参数校验与资源限制

| 工具 | 校验 | 限制常量 | 超限行为 |
|---|---|---|---|
| `read_file` | 非空字符串；必须是普通文件 | `MAX_FILE_BYTES = 200_000` | 返回 `ERROR: 文件过大…请缩小审查范围或分段读取` |
| `execute_code` | 非空字符串；长度受限；黑名单 | `MAX_CODE_CHARS = 20_000`；`EXEC_TIMEOUT_MS = 5_000` | 返回 `ERROR: 代码过长…` / `ERROR: 代码包含被禁止的操作：xxx` |

`read_file` 的输出按 `"%4d | %s"`（即 4 位右对齐 + ` | ` 前缀）加行号，目的是让模型在报告中能引用**准确行号**，也让「位置」这一报告要素可验证。

### 5.3 vm 沙箱的边界与局限

实现要点：

```js
const sandbox = { console: {...重定向...}, result: undefined };
const context = vm.createContext(sandbox, {
  name: "code-review-agent-sandbox",
  codeGeneration: { strings: false, wasm: false }, // 关闭 eval / new Function / WASM 编译
});
new vm.Script(code_snippet).runInContext(context, { timeout: 5000, displayErrors: true });
```

防护手段：

- **黑名单**：拦截 `require(`、`process.exit`、`child_process`、`fs.unlink`、`fs.rmdir`、`fs.rm(`；
- **超时**：`runInContext` 的 `timeout` 能中断同步死循环；
- **关闭代码生成**：`codeGeneration.strings = false` 削弱 `eval` / `new Function` 逃逸面；
- **输出回收**：自定义 `console` 把日志收集成数组，避免沙箱代码直接污染宿主的 stdout/stderr。

必须承认的局限：

- `vm` **不是安全边界**。它只做上下文隔离，历史上存在通过原型链、`constructor.constructor` 等路径逃逸的公开手法；
- `timeout` **只覆盖同步执行**。沙箱内 `setTimeout` / Promise 微任务不会被它中断（我们对 `console` 做了隔离，但未提供定时器 API，已尽量收窄）；
- 黑名单是**字符串匹配**，可被拼接、编码、`eval` 等手法绕过，属于「防手滑」而非「防攻击」。

结论：本沙箱面向「验证自己写的代码片段」这一受信场景。**生产环境请改用 `worker_threads` + 超时，或独立进程 / Docker 容器隔离并限制资源与网络。**

## 6. 上下文记忆

### 6.1 为什么用数组

ReAct 的每一步都强依赖**前序步骤的完整顺序**：模型要能看到自己上一轮的 Thought、发过的 Action、收到的 Observation，才能决定下一步。向量检索会打乱时序、丢失精确文本（例如行号），反而有害。因此选择「数组 + 滑动窗口」这一最朴素但语义正确的结构。

### 6.2 裁剪策略

```js
_trim() {
  const systemMessages = this.messages.filter((m) => m.role === "system");
  const otherMessages = this.messages.filter((m) => m.role !== "system");
  const limit = this.maxMemoryTurns * 2;             // 1 轮 ≈ user + assistant
  const kept = otherMessages.length > limit
    ? otherMessages.slice(-limit)                     // 只保留最近 N 条
    : otherMessages;
  this.messages = [...systemMessages, ...kept];
}
```

两个关键设计点：

1. **system 消息永久保留**。System Prompt 是工具协议与输出格式的唯一来源；一旦被裁掉，模型会立刻「失忆」并开始乱答。所以 `_trim` 先把 system 消息挑出来，裁剪后再拼回头部。
2. **按「条数」而非「token 数」裁剪**。实现零依赖、行为可预测；缺点是若单条 Observation 极大（例如 200KB 文件），仍可能超限——这正是给 `read_file` 设 200KB 上限的原因之一。

裁剪触发时机是每次 `add()` 之后，保证 `get()` 返回的永远是「已裁剪」的干净快照；`get()` 返回浅拷贝，避免调用方篡改内部状态。

## 7. 错误处理与重试

分三层，各层职责不重叠：

### 7.1 LLM 层（`llmClient.js`）

```js
// 分类 → 可重试则指数退避，不可重试则最多再给一次机会
if (retryable) {
  await sleep(2 ** attempt * 1000);   // 1s → 2s → 4s ...
  continue;
}
```

- **可重试**：请求超时、连接错误、429 限流、5xx 服务端错误 → 指数退避（`2^attempt` 秒），最多 `maxRetries` 次；
- **不可重试**：401/403/400 等客户端错误 → 用 `console.error` 记录后**最多再重试一次**，避免无意义循环；
- **未知异常**：统一由最外层 `catch` 记录为 `lastError`；
- **全部失败**：抛出 `Error("LLM 调用失败（最多重试 N 次）：<最后错误>")`，由 Agent 转成友好提示。
- SDK 内建重试被显式关闭（`maxRetries: 0`），避免 SDK 与本类双重重试造成的时间放大。

### 7.2 工具层（`fileTool.js` / `codeTool.js` / `registry.js`）

- **不抛异常**：所有失败路径返回 `"ERROR: ..."` 字符串；
- **错误可读**：错误信息包含具体原因与数值（如「文件过大（320000 字节），超过限制（200000 字节）」），让模型能据此决策；
- **统一兜底**：`registry.callTool` 用 `try/catch` 捕获工具内部意外异常，转成 `ERROR: 工具 xxx 执行失败：...`；
- **未知工具**：返回 `ERROR: 未知工具 xxx，可用工具：read_file, execute_code`，顺便把可用工具再告诉模型一次。

### 7.3 Agent 层（`agent.js` / `index.js`）

- **LLM 失败** → `review()` 捕获后返回「LLM 调用失败，无法继续审查：…」，不中断交互循环，用户可以换个方式提问；
- **格式错误** → 追加纠正提示并 `continue`（见 4.3）；
- **步数耗尽** → 返回明确提示，建议缩小范围或提高 `AGENT_MAX_STEPS`；
- **入口层兜底** → `main().catch()` 打印堆栈并 `process.exit(1)`；配置缺失时红字提示后以退出码 `1` 退出。

## 8. 命令行界面与交互

界面层刻意做得很薄（`src/index.js` 只有「收集输入 → 调用 Agent → 展示输出」），但它承担了三件容易被忽略的事：

### 8.1 启动与两种运行模式

启动时先打印一行运行上下文，让评分者 / 使用者一眼看到「用的是哪个模型、连的是哪个接口、Agent 手里有哪些工具」：

```
🔍 Code Review Agent
模型：deepseek-chat ｜ 接口：https://api.deepseek.com/v1 ｜ 可用工具：read_file, execute_code
```

随后进入两种模式之一：

| 命令 | 行为 |
|---|---|
| `npm start -- --file <路径>` | 单次审查：把「请审查文件 X，请先使用 read_file 读取」作为首轮输入，输出报告后进入交互模式 |
| `npm start -- --code "<代码>"` | 单次审查：把代码包成 Markdown 代码块作为首轮输入 |
| `npm start` | 直接进入交互模式，多轮追问 |
| `npm start -- ... --verbose` | 额外输出 ReAct 每一步的原始模型输出（调试用） |

交互模式用 `node:readline/promises` 实现，输入 `exit` / `quit` / `q` 退出，空行直接跳过。

### 8.2 输出通道分离与调试开关

- **报告走 stdout**（`process.stdout.write`），**日志与告警走 stderr**（`console.warn` / `console.error`），因此可以把报告重定向到文件而不被日志污染；
- `--verbose` 才保留 `console.debug`；默认把 `console.debug` 替换为空函数，避免每步的原始输出刷屏；
- stdin 被关闭（如管道输入结束）时，交互循环捕获异常并优雅退出，不会空转。

### 8.3 寒暄短路

交互模式最容易踩的坑是：用户随手敲一句「你好」，Agent 却把**上一轮的审查对象**又跑一遍——既费 token 又答非所问。因此入口层用一条**极窄**的正则做本地短路：

```js
const SMALL_TALK_RE = /^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在么|谢谢|多谢|感谢|thanks|thank you|thx|ok|okay|好的|好呢|收到|明白|嗯|嗯嗯|是|对)$/i;
function isSmallTalk(input) { return input.length > 0 && input.length <= 12 && SMALL_TALK_RE.test(input); }
```

只有「整句就是一句客套话」（长度 ≤ 12 且完全匹配）才命中，命中时本地回复并提示如何提供审查对象，**不发起 LLM 请求**。System Prompt 里也有一条对应规则（用户没有提供新内容时不要重复输出上一轮报告），两层互相兜底。

### 8.4 入口层兜底

| 场景 | 行为 |
|---|---|
| 配置错误（缺 Key / 仍是占位符 / 数值非法） | 红字提示 + `process.exit(1)`，避免误以为「正在正常请求」 |
| 未预期的异常 | `main().catch()` 打印堆栈 + 退出码 `1` |

## 9. 关键实现取舍

每个设计选择都有被放弃的替代方案，这里集中记录「选了什么、为什么、代价是什么」：

| # | 决策点 | 本项目选择 | 放弃的方案 | 理由与代价 |
|---|---|---|---|---|
| 1 | Agent 循环范式 | **手写 ReAct 文本协议**（Thought / Action / Action Input） | function calling（JSON Schema） | 逻辑透明、模型无关、零框架依赖，每一步 Thought 可见，便于讲解与调试；代价是格式靠 Prompt 约束，需要正则解析与纠错兜底（见 §4.3） |
| 2 | 工具错误如何传播 | 全部**字符串化**为 `ERROR: ...` | 向上抛异常 | 错误作为 Observation 回灌后模型能自我修正（换路径、缩小范围），循环不被打断；代价是错误类型信息被弱化为文本 |
| 3 | 代码执行的隔离方式 | `node:vm` + 黑名单 + 5 秒超时 + 关闭动态代码生成 | `worker_threads` / 子进程 / 容器 | 零依赖、启动快，足以支撑「验证自己写的小片段」；已明确声明 `vm` 不是安全边界（见 §5.3） |
| 4 | 上下文记忆结构 | 数组 + **滑动窗口裁剪** | 向量库检索 / LLM 摘要压缩 | ReAct 强依赖前序步骤的严格顺序与精确文本（含行号），向量检索反而有害；滑动窗口行为可预测、零依赖；代价是早期细节会丢失 |
| 5 | 交互形态 | **CLI**（单次审查 + 多轮对话） | Web / GUI | 作业规模下链路最短，演示与复现成本最低，评审者一条命令即可跑通；代价是缺少图形化的步骤可视化，Web 化见 §11 |
| 6 | 重试的归属 | **自己实现**指数退避并关闭 SDK 内建重试（`maxRetries: 0`） | 依赖 SDK 默认重试 | 避免 SDK 与本类双重重试造成的时间放大，且退避时长、重试原因都能进日志，可观测 |
| 7 | 采样温度 | `temperature = 0.2` | 更高温度（更有"创造性"的分析） | 本项目的输出要被正则解析、报告要有固定结构，**格式稳定性优先于多样性**；代价是措辞可能略显模板化 |
| 8 | 配置的读取方式 | 单一 `src/config.js` 集中读取 + 启动期 `validateConfig` | 各模块直接读 `process.env` | 默认值集中管理、类型转换只写一次；缺 Key、Key 仍是模板占位符这类高频坑在**启动时**就能被拦下并给出可操作提示 |
| 9 | 依赖清单的位置 | `package.json` / `package-lock.json` 放在 `code-review-agent/` 内 | 仓库根目录放单独依赖文件（如 `requirements.txt`） | Node 生态约定 `package.json` 必须与源码同级，`npm install` / `npm start` 才能直接以项目目录为根工作；因此本仓库的**文档在根目录、可运行工程在 `code-review-agent/` 子目录** |

## 10. 边界情况与优化建议

| # | 边界情况 | 处理方案 | 可优化方向 |
|---|---|---|---|
| 1 | **代码文件过大** | `read_file` 限制 `MAX_FILE_BYTES = 200KB`，超限返回 ERROR，引导模型让用户缩小范围 | 改为分段读取 + 行范围参数 `{ file_path, start_line, end_line }` |
| 2 | **LLM 输出非法 JSON** | `_parseAction` / `_tryParseJson` 容错：`JSON.parse` 失败后替换单引号、去尾随逗号、补全右括号再试；仍失败则返回 `null` 并追加格式纠正提示后 `continue` | 改用 function calling / JSON Schema 约束输出 |
| 3 | **API 超时 / 限流** | `llmClient.chat` 捕获超时与 429，指数退避（`2^n` 秒）重试，最多 `maxRetries` 次；仍失败抛 Error，Agent 返回友好提示 | 引入令牌桶限速与抖动（jitter）退避 |
| 4 | **工具执行死循环 / 耗时过长** | `vm.Script.runInContext` 传入 `timeout: 5000`；文档中明确生产环境应使用 `worker_threads` + 超时或子进程隔离 | 迁移到 `worker_threads`，支持异步代码与并发执行 |
| 5 | **危险代码执行** | `execute_code` 黑名单校验 `require(`、`process.exit`、`child_process`、`fs.unlink`、`fs.rmdir`、`fs.rm(`，命中直接返回 ERROR | 用 **允许列表**（纯函数白名单）替代黑名单，或直接在容器中执行 |
| 6 | **上下文记忆溢出** | `Memory._trim` 保留 system + 最近 `maxMemoryTurns * 2` 条 | 引入 LLM 摘要压缩，把早期对话压成一条「历史摘要」 |
| 7 | **模型不擅长 ReAct 格式** | System Prompt 给出严格格式示例；`temperature` 降至 0.2；解析层做容错与纠正 | 切换到 function calling 模式，用 JSON Schema 强制结构 |
| 8 | **达到最大步数仍未出 Final Answer** | 返回明确提示，建议用户缩小审查范围或提高 `AGENT_MAX_STEPS` | 在步数用尽前主动注入「请立即给出 Final Answer」 |
| 9 | **Action Input 参数值里含 `}`**（如代码片段含 `if (x) { ... }`） | 非贪婪正则失败后，用贪婪正则 `\{[\s\S]*\}` 兜底并重试解析 | 用带括号配平的解析器或直接走 function calling |
| 10 | **模型返回空内容 / 空 Final Answer** | `chat()` 对空字符串抛错进入重试；`_extractFinalAnswer` 返回 `null` 触发下一轮 | 增加「空响应」专项重试与告警统计 |
| 11 | **非 TTY 环境（管道输入）** | 交互循环监听 `rl.on("close")` 并捕获 `question()` 异常，输入结束时优雅退出，不空转 | 增加 `--no-interactive` 显式开关 |
| 12 | **同一文件被反复读取** | 目前依赖 Prompt 中的「不要重复执行同样的错误动作」约束 | 在 `registry` 层加读取缓存，命中时返回 `（与上次读取内容相同，已省略）` |

## 11. 可扩展方向

1. **切换到 function calling**：把 `TOOL_REGISTRY` 转成 OpenAI `tools` 参数（JSON Schema），由模型直接返回结构化 tool_calls，彻底摆脱正则解析与格式纠正逻辑。`agent.js` 的循环结构可以原样保留，只替换「解析」与「调用」两处。
2. **Web 界面**：把 `CodeReviewAgent` 包在一个 HTTP 服务里（如 Express + SSE），前端做流式输出，`read_file` 改为读取上传的文件或 Git 仓库快照。
3. **向量记忆**：为多文件、跨会话的项目级审查引入向量库，把历史审查结论与代码片段索引起来，实现「这个 Bug 上次修过吗」这类长期记忆。
4. **多文件 / 仓库级审查**：新增 `list_files`、`grep`、`git_diff` 工具，配合 ReAct 循环做分层审查（先看目录结构 → 定位可疑文件 → 逐文件细读），并支持审查 PR diff。
5. **更安全的执行环境**：把 `execute_code` 替换为「Docker 一次性容器 + CPU/内存/网络限制」，并支持多语言（Python / Shell），使「动手验证」在真实项目上可用。
6. **审查结果结构化输出**：让 Final Answer 同时产出一份 JSON（问题列表 + 严重程度 + 行号），便于接入 CI（例如把结果作为 PR review comment 回写）。
