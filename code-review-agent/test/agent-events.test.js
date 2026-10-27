import assert from "node:assert/strict";
import test from "node:test";

import { CodeReviewAgent } from "../src/core/agent.js";

const TEST_CONFIG = {
  apiKey: "test-key",
  baseURL: "http://127.0.0.1:1/v1",
  model: "mock-model",
  timeout: 100,
  maxRetries: 1,
  maxAgentSteps: 4,
  maxMemoryTurns: 4,
};

test("review emits a complete event stream for a tool-assisted report", async () => {
  const originalDebug = console.debug;
  console.debug = () => {};

  try {
    const agent = new CodeReviewAgent(TEST_CONFIG);
    let callCount = 0;
    agent.llm = {
      chat: async () => {
        callCount += 1;
        if (callCount === 1) {
          return [
            "Thought: 先运行一个最小验证。",
            "Action: execute_code",
            'Action Input: {"code_snippet":"console.log(2 + 2)"}',
          ].join("\n");
        }
        return [
          "Thought: 信息已经足够。",
          "Final Answer: # 总体评价",
          "代码可以运行。",
          "",
          "# 问题清单",
          "- 【低】建议补充边界测试。",
        ].join("\n");
      },
    };

    const events = [];
    const report = await agent.review("请审查测试代码", {
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "step", "thought", "action", "observation", "step", "thought", "report"],
    );
    assert.equal(events[3].action, "execute_code");
    assert.match(events[4].result, /4/);
    assert.equal(events[4].ok, true);
    assert.match(report, /# 总体评价/);
    assert.match(events.at(-1).content, /建议补充边界测试/);
  } finally {
    console.debug = originalDebug;
  }
});

test("review still returns a report when no event callback is supplied", async () => {
  const agent = new CodeReviewAgent(TEST_CONFIG);
  agent.llm = {
    chat: async () => "Thought: 已完成。\nFinal Answer: 审查完成。",
  };

  assert.equal(await agent.review("审查这段代码"), "审查完成。");
});
