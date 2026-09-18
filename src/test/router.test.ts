import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  buildState,
  chooseNextTool,
  gate,
  groupOf,
  groupTools,
  limitOptions,
  MAX_OPTIONS,
  RESPOND,
  SINGLE_STAGE_MAX,
  stubDecision,
  type RouterState,
  type ToolSpec,
} from "../router.js";

const state = (tools: string[]): RouterState => ({
  user_request: "do the thing",
  actions_taken: tools.map((t, i) => ({ step: i + 1, tool: t, input: "{}", result: "ok" })),
  assistant_said: [],
});

const ranked: [string, number][] = [
  [RESPOND, 0.6],
  ["Edit", 0.3],
  ["Bash", 0.1],
];

after(() => {
  delete process.env.DONE_THRESHOLD;
  delete process.env.JEV_STUB;
  delete process.env.JEV_SINGLE_STAGE_MAX;
});

test("groupOf derives the group from the tool name", () => {
  assert.equal(groupOf("Read"), "core");
  assert.equal(groupOf("mcp__notion__api"), "mcp:notion");
  assert.equal(groupOf("mcp__my-server__tool"), "mcp:my-server");
  assert.equal(groupOf("linear:issue_create"), "mcp:linear");
});

test("groupTools partitions the catalog preserving order", () => {
  const groups = groupTools([
    { name: "Read" }, { name: "mcp__a__x" }, { name: "Edit" }, { name: "mcp__a__y" }, { name: "mcp__b__z" },
  ]);
  assert.deepEqual(groups.map((g) => g.name), ["core", "mcp:a", "mcp:b"]);
  assert.deepEqual(groups[0]?.tools.map((t) => t.name), ["Read", "Edit"]);
  assert.deepEqual(groups[1]?.tools.map((t) => t.name), ["mcp__a__x", "mcp__a__y"]);
});

test("buildState pairs tool calls with their results", () => {
  const built = buildState([
    { role: "user", text: "fix it" },
    { role: "assistant", text: "reading", calls: [{ id: "a", tool: "Read", input: { file: "x" } }] },
    { role: "tool", id: "a", output: "contents" },
    { role: "user", text: "and test it" },
  ]);
  assert.equal(built.user_request, "fix it\n---\nand test it");
  assert.deepEqual(built.assistant_said, ["reading"]);
  assert.deepEqual(built.actions_taken, [{ step: 1, tool: "Read", input: "{\"file\":\"x\"}", result: "contents" }]);
});

test("buildState clips long results", () => {
  const built = buildState([
    { role: "assistant", calls: [{ id: "a", tool: "Read", input: {} }] },
    { role: "tool", id: "a", output: "x".repeat(1000) },
  ]);
  assert.equal(built.actions_taken[0]?.result.length, 601);
  assert.ok(built.actions_taken[0]?.result.endsWith("…"));
});

test("buildState fits the provider state budget", () => {
  process.env.JEV_STATE_CHAR_MAX = "5000";
  try {
    const turns: import("../router.js").Turn[] = [
      { role: "user", text: "q".repeat(20000) },
      ...Array.from({ length: 50 }, (_, i) => ({ role: "tool" as const, id: `a${i}`, tool: `t${i}`, output: "r".repeat(2000) })),
    ];
    const built = buildState(turns);
    const size = JSON.stringify(built).length;
    assert.ok(size <= 5000, `state was ${size} chars, budget 5000`);
    // The most recent actions survive the cut.
    assert.equal(built.actions_taken.at(-1)?.tool, "t49");
  } finally {
    delete process.env.JEV_STATE_CHAR_MAX;
  }
});

test("buildState clips oversized tool inputs", () => {
  const built = buildState([
    { role: "assistant", calls: [{ id: "a", tool: "Write", input: { content: "x".repeat(2000) } }] },
    { role: "tool", id: "a", output: "ok" },
  ]);
  assert.ok((built.actions_taken[0]?.input ?? "").length <= 501);
});

test("buildState tolerates a tool result with no matching call", () => {
  const built = buildState([{ role: "tool", id: "orphan", tool: "Bash", output: "hi" }]);
  assert.deepEqual(built.actions_taken, [{ step: 1, tool: "Bash", input: "", result: "hi" }]);
});

test("gate overrides a premature respond_to_user", () => {
  process.env.DONE_THRESHOLD = "0.5";
  assert.deepEqual(gate(RESPOND, 0.2, ranked), { tool: "Edit", gated: true });
});

test("gate leaves respond_to_user alone when done agrees", () => {
  process.env.DONE_THRESHOLD = "0.5";
  assert.deepEqual(gate(RESPOND, 0.9, ranked), { tool: RESPOND, gated: false });
});

test("gate never touches a real tool choice", () => {
  process.env.DONE_THRESHOLD = "0.5";
  assert.deepEqual(gate("Edit", 0.0, ranked), { tool: "Edit", gated: false });
});

test("gate honours DONE_THRESHOLD", () => {
  process.env.DONE_THRESHOLD = "0.1";
  assert.deepEqual(gate(RESPOND, 0.2, ranked), { tool: RESPOND, gated: false });
  process.env.DONE_THRESHOLD = "0.5";
});

test("gate keeps respond_to_user when it is the only option", () => {
  process.env.DONE_THRESHOLD = "0.5";
  assert.deepEqual(gate(RESPOND, 0.0, [[RESPOND, 1]]), { tool: RESPOND, gated: false });
});

test("stub picks the first tool that has not run yet", () => {
  const options: ToolSpec[] = [{ name: "Read" }, { name: "Edit" }, { name: "Bash" }];
  assert.equal(stubDecision(state(["Read"]), options, false).tool, "Edit");
  assert.equal(stubDecision(state(["Read", "Edit", "Bash"]), options, false).tool, RESPOND);
  assert.equal(stubDecision(state(["Read", "Edit", "Bash"]), options, false).done, 1);
});

test("limitOptions truncates above 255 labels", () => {
  const many: ToolSpec[] = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}` }));
  const cut = limitOptions(many);
  assert.equal(cut.truncated, true);
  assert.equal(cut.options.length, MAX_OPTIONS - 1);
  assert.equal(cut.options[0]?.name, "t0");
  assert.equal(cut.options.at(-1)?.name, "t253");

  const few = limitOptions(many.slice(0, MAX_OPTIONS - 1));
  assert.equal(few.truncated, false);
  assert.equal(few.options.length, MAX_OPTIONS - 1);
});

test("limitOptions honours a smaller maxCount", () => {
  const many: ToolSpec[] = Array.from({ length: 259 }, (_, i) => ({ name: `t${i}` }));
  const cut = limitOptions(many, 190);
  assert.equal(cut.truncated, true);
  assert.equal(cut.options.length, 189); // 189 tools + respond_to_user = 190 labels
});

test("chooseNextTool clips long tool descriptions before sending to Jev", async () => {
  let seen: Record<string, string> | undefined;
  const evaluate = async (input: { criteria: Record<string, string> }) => {
    seen = input.criteria;
    return { choice: "Read", probabilities: { Read: 0.9, respond_to_user: 0.1 }, confidence: 0.9, done: 0.1 };
  };
  const long = "x".repeat(1000);
  await chooseNextTool(state([]), [{ name: "Read", description: long }], evaluate);
  assert.ok(seen);
  const entry = seen["Read"] ?? "";
  assert.equal(entry.length, 301); // 300 chars + ellipsis
  assert.ok(entry.endsWith("…"));
});

test("chooseNextTool uses two stages when the catalog is large", async () => {
  const calls: { instructions: string; criteria: Record<string, string> }[] = [];
  const evaluate: (input: { instructions: string; criteria: Record<string, string> }) => Promise<{ choice: string; probabilities: Record<string, number>; confidence: number; done: number }> = async (input) => {
    calls.push({ instructions: input.instructions, criteria: input.criteria });
    const isGroupStage = input.instructions.includes("GROUP");
    if (isGroupStage) {
      const p: Record<string, number> = { "mcp:big": 0.8, respond_to_user: 0.2 };
      return { choice: "mcp:big", probabilities: p, confidence: 0.8, done: 0.1 };
    }
    const p: Record<string, number> = { "mcp__big__tool2": 0.7, "mcp__big__tool1": 0.2, respond_to_user: 0.1 };
    return { choice: "mcp__big__tool2", probabilities: p, confidence: 0.7, done: 0.1 };
  };
  const options: ToolSpec[] = [
    { name: "Read" },
    ...Array.from({ length: SINGLE_STAGE_MAX + 10 }, (_, i) => ({ name: `mcp__big__tool${i}` })),
  ];
  const decision = await chooseNextTool(state([]), options, evaluate);
  assert.equal(decision.tool, "mcp__big__tool2");
  assert.equal(decision.group, "mcp:big");
  assert.equal(calls.length, 2);
  // Stage 1 criteria: one label per group, never a raw tool name.
  assert.ok(Object.hasOwn(calls[0]!.criteria, "mcp:big"));
  assert.ok(!Object.hasOwn(calls[0]!.criteria, "mcp__big__tool0"));
  // Stage 2 criteria: only tools of the chosen group.
  assert.ok(Object.hasOwn(calls[1]!.criteria, "mcp__big__tool2"));
  assert.ok(!Object.hasOwn(calls[1]!.criteria, "Read"));
  assert.equal(decision.stages?.length, 2);
});

test("two-stage routing stops after stage 1 when Jev says respond", async () => {
  let calls = 0;
  const evaluate = async (input: { instructions: string }) => {
    calls++;
    assert.ok(input.instructions.includes("GROUP"));
    return { choice: RESPOND, probabilities: { [RESPOND]: 0.9 }, confidence: 0.9, done: 0.9 };
  };
  // 155 groups (max group size 1) forces two stages.
  const options: ToolSpec[] = Array.from({ length: 155 }, (_, i) => ({ name: `mcp__g${i}__t` }));
  const decision = await chooseNextTool(state([]), options, evaluate);
  assert.equal(decision.tool, RESPOND);
  assert.equal(decision.done, 0.9);
  assert.equal(calls, 1);
  assert.equal(decision.stages?.length, 1);
});

test("group count alone triggers two stages even for a small catalog", async () => {
  process.env.JEV_SINGLE_STAGE_MAX = "4";
  try {
    const calls: { instructions: string }[] = [];
    const evaluate: (input: { instructions: string }) => Promise<{ choice: string; probabilities: Record<string, number>; confidence: number; done: number }> = async (input) => {
      calls.push({ instructions: input.instructions });
      if (input.instructions.includes("GROUP")) {
        const p: Record<string, number> = { "mcp:a": 0.9, respond_to_user: 0.1 };
        return { choice: "mcp:a", probabilities: p, confidence: 0.9, done: 0.1 };
      }
      const p: Record<string, number> = { "mcp__a__x": 0.9, respond_to_user: 0.1 };
      return { choice: "mcp__a__x", probabilities: p, confidence: 0.9, done: 0.1 };
    };
    // 5 tools in 5 groups > 4: two stages required.
    const options: ToolSpec[] = [{ name: "mcp__a__x" }, { name: "mcp__b__x" }, { name: "mcp__c__x" }, { name: "mcp__d__x" }, { name: "mcp__e__x" }];
    const decision = await chooseNextTool(state([]), options, evaluate);
    assert.equal(decision.tool, "mcp__a__x");
    assert.equal(calls.length, 2);
  } finally {
    delete process.env.JEV_SINGLE_STAGE_MAX;
  }
});

test("stage 1 can answer with a tool label (grouping not in the name)", async () => {
  const calls: { criteria: Record<string, string> }[] = [];
  const evaluate: (input: { instructions: string; criteria: Record<string, string> }) => Promise<{ choice: string; probabilities: Record<string, number>; confidence: number; done: number }> = async (input) => {
    calls.push({ criteria: input.criteria });
    if (input.instructions.includes("GROUP")) {
      // Jev answers with a raw tool name instead of a group label.
      const p: Record<string, number> = { Read: 0.9, respond_to_user: 0.1 };
      return { choice: "Read", probabilities: p, confidence: 0.9, done: 0.1 };
    }
    const p: Record<string, number> = { Read: 0.9, "mcp__a__x": 0.05, respond_to_user: 0.05 };
    return { choice: "Read", probabilities: p, confidence: 0.9, done: 0.1 };
  };
  process.env.JEV_SINGLE_STAGE_MAX = "4";
  try {
    const options: ToolSpec[] = [{ name: "Read" }, { name: "Edit" }, { name: "mcp__a__x" }, { name: "mcp__b__x" }, { name: "mcp__c__x" }];
    const decision = await chooseNextTool(state([]), options, evaluate);
    assert.equal(decision.tool, "Read");
    assert.equal(calls.length, 2);
    // Stage 2 scoped to the group containing the stage-1 answer: only core tools.
    assert.ok(Object.hasOwn(calls[1]!.criteria, "Read"));
    assert.ok(!Object.hasOwn(calls[1]!.criteria, "mcp__a__x"));
  } finally {
    delete process.env.JEV_SINGLE_STAGE_MAX;
  }
});

test("small catalogs stay single-stage", async () => {
  const calls: { criteria: Record<string, string> }[] = [];
  const evaluate = async (input: { criteria: Record<string, string> }) => {
    calls.push({ criteria: input.criteria });
    return { choice: "Read", probabilities: { Read: 0.9, respond_to_user: 0.1 }, confidence: 0.9, done: 0.1 };
  };
  const decision = await chooseNextTool(state([]), [{ name: "Read" }, { name: "Edit" }], evaluate);
  assert.equal(calls.length, 1);
  assert.ok(Object.hasOwn(calls[0]!.criteria, "Read"));
  assert.equal(decision.group, undefined);
});

test("chooseNextTool in stub mode reports truncation and needs no API key", async () => {
  process.env.JEV_STUB = "1";
  delete process.env.TYPESAFE_API_KEY;
  const many: ToolSpec[] = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}` }));
  const decision = await chooseNextTool(state([]), many);
  assert.equal(decision.truncated, true);
  assert.equal(decision.tool, "t0");
  assert.equal(decision.gated, false);
  assert.equal(decision.latencyMs, 0);
});
