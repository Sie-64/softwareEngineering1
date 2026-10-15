# Code Review Agent - 代码审查智能体

一个基于 DeepSeek API（OpenAI 兼容协议）的代码审查 Agent：**先读代码，必要时动手跑一段代码复现问题，再输出结构化审查报告**（总体评价 / 问题清单 / 修复建议）。

对应课程作业方向：**代码审查 Agent**（分析代码质量、发现潜在 Bug、评估健壮性与可维护性）。

## 功能特性

- Agent 循环：输入 → 推理 → 工具调用 → 输出，单轮最多 8 轮迭代（`AGENT_MAX_STEPS`）
- 2 个工具：
  - `read_file`：读取带行号的源码（单文件 ≤ 200 KB），为报告提供**可核对的行号**
  - `execute_code`：在 `node:vm` 沙箱中执行一小段 JS（≤ 20000 字符、5 秒超时、危险调用黑名单），用于**动手复现**问题（如「空数组求平均会得到 `NaN`」）
- 上下文记忆：数组式对话记忆 + 滑动窗口裁剪，system 消息永久保留
- 错误处理：LLM 调用指数退避重试（1s → 2s → 4s，默认 3 次）；工具错误字符串化回灌给模型自我修正；输出格式不合规时自动追加纠正提示
- 命令行交互：单次审查（`--file` / `--code`）+ 多轮对话两种模式，`--verbose` 可查看 ReAct 每一步
- 模型可切换：任何 OpenAI 兼容接口（DeepSeek / OpenAI / 通义千问 / Kimi），只改 `.env` 两行
- 纯手写 ReAct 循环：不依赖 LangChain 等重框架，调用链透明、便于讲解与调试

## 技术栈

| 组件 | 选型 |
|---|---|
| 语言 / 运行时 | Node.js ≥ 18（原生 ESM、`fetch`、`node:vm`） |
| LLM | DeepSeek `deepseek-chat`（OpenAI 兼容协议，官方 `openai` SDK） |
| Agent 框架 | 无框架，手写 ReAct 循环（Thought → Action → Observation） |
| CLI | `commander`（参数解析）+ `node:readline/promises`（交互循环） |
| 其他依赖 | `dotenv`（配置）、`chalk`（终端着色）、`node:vm`（沙箱执行，内置） |

## 快速开始

```bash
# 1) 安装依赖（可运行的工程在 code-review-agent/ 目录下）
cd code-review-agent
npm install

# 2) 配置 API Key（到 https://platform.deepseek.com 申请）
cp .env.example .env          # Windows PowerShell: copy .env.example .env
# 编辑 .env，把 OPENAI_API_KEY 换成真实 Key

# 3) 运行
npm start                                     # 交互模式（多轮追问）
npm start -- --file examples/sampleBuggy.js   # 审查一个文件
npm run review:file                           # 与上一条等价的快捷脚本
npm start -- --code "function add(a,b){return a+b}"
npm start -- --file examples/sampleBuggy.js --verbose   # 打印 ReAct 每一步
```

> ⚠️ **`cp .env.example .env` 只做一次。** 如果 `.env` 已经配好，再执行这条命令会把 Key 覆盖回占位符
> `your_api_key_here`，运行时收到 401（报错形如 `401 Authentication Fails, Your api key: ****here is invalid`）。
> 遇到该报错请先检查 `.env` 里的 Key 是否被覆盖回模板值。

> 退出交互模式：输入 `exit`（也支持 `quit` / `q`）。

## 使用示例

以仓库内的示例文件为例（`examples/sampleBuggy.js` 里**刻意埋了 5 个典型问题**：除零、数组越界、空数组求平均、`null` 解引用、未捕获的异步异常）：

```bash
$ npm start -- --file examples/sampleBuggy.js
```

Agent 的执行过程如下（可在 `--verbose` 下逐条观察）：

1. **Thought**：判断要审查的是一个文件路径 → 决定先读文件；
2. **Action** `read_file` + `Action Input {"file_path": "examples/sampleBuggy.js"}` → 拿到带行号的全文；
3. **可选**：对「`average([])` 到底返回什么」这类问题调用 `execute_code` 复现，用真实输出代替猜测；
4. **Final Answer**：输出 Markdown 审查报告，结构固定为
   - 总体评价；
   - 问题清单（按【高】【中】【低】分级，每条含位置、问题描述、触发原因 / 复现条件、修复建议）；
   - 针对高优先级问题的修复代码片段。

也可以直接审查一段代码，或进入交互模式连续追问（例如「第 3 个问题的修复为什么这样做？」）：

```bash
$ npm start -- --code "function divide(a, b) { return a / b; }"
$ npm start
```

## 项目结构

```
softwareEngineering1/
│
├── README.md                    # 项目说明（本文件）
├── Design.md                    # 设计文档（架构、ReAct 时序、Prompt、沙箱边界、设计取舍…）
├── .gitignore                   # 忽略 node_modules / .env / 系统文件
│
└── code-review-agent/           # 可运行的工程（唯一的源码目录）
    ├── package.json             # 项目清单：依赖、脚本、ESM 声明
    ├── package-lock.json        # 依赖锁定
    ├── .env.example             # 环境变量模板（复制为 .env 后填 Key；.env 不入库）
    ├── .gitignore               # 工程级忽略规则
    │
    ├── src/
    │   ├── index.js             # 【入口层】CLI 入口 + 交互循环
    │   ├── config.js            # 【配置层】读取并校验环境变量
    │   ├── core/
    │   │   ├── agent.js         # Agent 主循环（ReAct）
    │   │   ├── llmClient.js     # LLM 调用封装（超时 / 重试 / 退避）
    │   │   ├── memory.js        # 对话记忆（含滑动窗口裁剪）
    │   │   └── prompts.js       # System Prompt + ReAct 提示语
    │   └── tools/
    │       ├── registry.js      # 工具注册表 + 统一调度
    │       ├── fileTool.js      # read_file 工具
    │       └── codeTool.js      # execute_code 工具
    │
    └── examples/
        └── sampleBuggy.js       # 含典型 Bug 的示例代码
```

## 配置项

所有配置集中在 `code-review-agent/.env`（可复制 `.env.example` 得到）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 无（必填） | 模型服务密钥；为空或仍是占位符时启动即报错退出 |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | 接口地址，可换成任意 OpenAI 兼容服务 |
| `OPENAI_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_TIMEOUT` | `60000` | 单次 LLM 请求超时（毫秒） |
| `LLM_MAX_RETRIES` | `3` | 单次请求最大重试次数 |
| `AGENT_MAX_STEPS` | `8` | 单轮审查最多 ReAct 步数 |
| `AGENT_MAX_MEMORY_TURNS` | `10` | 记忆保留的最大对话轮数 |

切换模型只需改 `OPENAI_BASE_URL` 与 `OPENAI_MODEL`，代码无需改动。常用组合：

| 服务 | `OPENAI_BASE_URL` | `OPENAI_MODEL` 示例 |
|---|---|---|
| **DeepSeek（当前默认）** | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问（DashScope 兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

> DeepSeek 建议用 `deepseek-chat`（DeepSeek-V3）：它支持 `temperature` 且格式遵循稳定；`deepseek-reasoner`
> （R1）会输出思维链、对采样参数支持有限，本项目的 ReAct 解析依赖低温度下的稳定格式。

## 工具协议

两个工具遵循同一契约：**接收一个对象参数、失败时返回以 `ERROR:` 开头的字符串而不抛异常**（错误会作为 Observation 回灌给模型，让它自行修正）。

| 工具 | 参数 | 限制 | 返回 |
|---|---|---|---|
| `read_file` | `{ file_path: string }` | 必须是普通文件；≤ 200 KB（`MAX_FILE_BYTES`） | 带行号全文（`  12 \| const a = 1;`），或 `ERROR: ...` |
| `execute_code` | `{ code_snippet: string }` | ≤ 20000 字符（`MAX_CODE_CHARS`）；执行超时 5 秒；命中黑名单直接拒绝 | 标准输出 / 标准错误 / 异常堆栈 / `返回值`，或 `ERROR: ...` |

`execute_code` 的黑名单关键词：`require(`、`process.exit`、`child_process`、`fs.unlink`、`fs.rmdir`、`fs.rm(`。

## 注意事项

- ⚠️ **`execute_code` 不是安全沙箱**。`node:vm` 只做上下文隔离，理论上仍可被逃逸利用。本项目用黑名单、长度限制、5 秒超时、关闭动态代码生成来降低风险；**生产环境请改用 `worker_threads` + 超时或独立容器隔离**（详见 [Design.md](Design.md) §5.3）。
- `examples/sampleBuggy.js` 中的 `module.exports` 是**刻意保留**的：用于演示 `require(` 黑名单会被命中。该文件仅作为「被审查的文本」，请勿直接 `node` 运行它；被审查对象本身可以是任意语言的代码。
- 🔧 **模型输出格式不稳时**：项目已把 `temperature` 固定为 `0.2` 并在 System Prompt 中给出严格格式示例；若仍频繁输出非法格式，建议换用指令遵循能力更强的模型，或按 [Design.md](Design.md) §11 的方向改用 function calling。
- 💰 **长对话注意 Token 成本**：记忆只做滑动窗口裁剪（不做摘要压缩），`AGENT_MAX_MEMORY_TURNS` 越大成本越高。

更多设计细节（分层架构、ReAct 单步时序、Prompt 全文、沙箱边界、错误处理与重试、关键实现取舍）见 [Design.md](Design.md)。
