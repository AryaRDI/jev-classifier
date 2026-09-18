import { type EntryType } from "@typesafe-ai/sdk";
import { evaluateJev } from "./jev.js";

/** Pseudo-tool meaning "no tool: answer the user now". */
export const RESPOND = "respond_to_user";

/** A Jev `choice` question takes at most 255 labels, `respond_to_user` included. */
export const MAX_OPTIONS = 255;

/**
 * The provider rejects a choice question at ~200 labels (HTTP 400 max_tokens_exceeded)
 * and at ~128 KB of state. LABEL_HARD_MAX keeps the label count safe; STATE_CHAR_MAX
 * keeps the serialized state safe. Both are enforced in chooseNextTool/buildState.
 */
export const SINGLE_STAGE_MAX = Number(process.env.JEV_SINGLE_STAGE_MAX ?? 150);
export const LABEL_HARD_MAX = Number(process.env.JEV_LABEL_HARD_MAX ?? 190);
export const STATE_CHAR_MAX = Number(process.env.JEV_STATE_CHAR_MAX ?? 60_000);
export function stateCharMax(): number {
  return Number(process.env.JEV_STATE_CHAR_MAX ?? STATE_CHAR_MAX);
}

/** Keep only this many tool names in a group label; the rest add no routing signal. */
const GROUP_SAMPLE = 5;

/**
 * Group label for a tool name. MCP tools carry their server in the name
 * (`mcp__server__tool`, `server:tool`); everything else is the agent's built-in group.
 */
export function groupOf(name: string): string {
  const mcp = /^mcp__(.+?)__/.exec(name);
  if (mcp) return `mcp:${mcp[1]}`;
  const colon = name.split(":")[0];
  if (colon && colon !== name && /^[a-z0-9_-]+$/i.test(colon) && name.length > colon.length + 1) return `mcp:${colon}`;
  return "core";
}

export interface GroupSpec {
  readonly name: string;
  readonly tools: readonly ToolSpec[];
}

/** Partition the catalog into groups, preserving first-seen order. */
export function groupTools(options: readonly ToolSpec[]): GroupSpec[] {
  const groups = new Map<string, ToolSpec[]>();
  for (const option of options) {
    const key = groupOf(option.name);
    const list = groups.get(key) ?? [];
    list.push(option);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([name, tools]) => ({ name, tools }));
}

export interface ToolSpec {
  readonly name: string;
  readonly description?: string;
}

export interface Action {
  readonly step: number;
  readonly tool: string;
  readonly input: string;
  readonly result: string;
}

export interface RouterState {
  readonly user_request: string;
  readonly actions_taken: readonly Action[];
  readonly assistant_said: readonly string[];
}

export interface RouterDecision {
  readonly tool: string;
  readonly confidence: number;
  /** Probability (0-1) that every requested action is already done. */
  readonly done: number;
  /** True when the gate overrode a premature respond_to_user. */
  readonly gated: boolean;
  readonly top: readonly { name: string; p: number }[];
  readonly latencyMs: number;
  readonly state: RouterState;
  /** True when the tool list was cut to fit MAX_OPTIONS. */
  readonly truncated: boolean;
  /** Stage 1: the group Jev picked, when two-stage routing ran. */
  readonly group?: string;
  /** Milliseconds per stage, in order. Length 2 when two-stage routing ran. */
  readonly stages?: readonly number[];
  /** Combined provider token usage across stages, when the provider reports it. */
  readonly tokens?: { in: number; out: number };
}

/** Normalized conversation turn. Every adapter lowers its own wire format to this. */
export type Turn =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text?: string;
      readonly calls?: readonly { id: string; tool: string; input: unknown }[];
    }
  | { readonly role: "tool"; readonly id: string; readonly tool?: string; readonly output: unknown };

const INSTRUCTIONS =
  "You are routing a coding agent. Given the user's request and the actions already taken (with their results), " +
  "which tool should the assistant call NEXT to make progress? Choose exactly one. " +
  "Follow the order implied by the request: read and search before editing, and honour conditions ('if…'). " +
  "Never repeat an action that already succeeded. If everything requested is done, choose respond_to_user.";

const GROUP_INSTRUCTIONS =
  "You are routing a coding agent. The tool catalog is grouped by source (agent built-ins, one group per MCP server). " +
  "Given the user's request and the actions already taken, which GROUP contains the tool the assistant should call NEXT? " +
  "Choose exactly one group. If everything requested is done and no tool is needed, choose respond_to_user.";

const DONE_INSTRUCTIONS =
  "Every single action the user asked for (each read, search, edit, command, commit…) already appears as a successful entry in actions_taken. " +
  "False if at least one requested action has not been carried out yet, or a needed lookup returned nothing useful.";

const RESPOND_CRITERION = {
  what:
    "No tool call is needed now: every part of the request has been carried out (results are already in actions_taken) " +
    "or nothing in the catalog applies. The assistant should write its final answer.",
  not_for: "Cases where a step of the request (a read, a search, an edit, a command) has not happened yet.",
};

export function doneThreshold(): number {
  return Number(process.env.DONE_THRESHOLD ?? 0.5);
}

export function minConfidence(): number {
  return Number(process.env.MIN_CONFIDENCE ?? 0.5);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "type" in p && (p as { type: string }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function clip(value: unknown, max = 600): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Re-clip a state so its JSON serialization fits the provider budget. */
function fitState(state: RouterState, maxChars: number): RouterState {
  if (JSON.stringify(state).length <= maxChars) return state;
  const actions: Action[] = state.actions_taken.map((a) => ({ step: a.step, tool: a.tool, input: clip(a.input, 200), result: clip(a.result, 200) }));
  let fitted: RouterState = { ...state, actions_taken: actions };
  if (JSON.stringify(fitted).length <= maxChars) return fitted;
  const user_request = clip(state.user_request, Math.max(2000, Math.floor(maxChars / 4)));
  fitted = { ...fitted, user_request };
  if (JSON.stringify(fitted).length <= maxChars) return fitted;
  // Last resort: keep the most recent actions only.
  let keep = actions.length;
  while (keep > 1 && JSON.stringify({ ...fitted, actions_taken: actions.slice(-keep) }).length > maxChars) keep--;
  return { ...fitted, actions_taken: actions.slice(-keep) };
}

/** Turn a normalized message history into the compact JSON state Jev sees. */
export function buildState(turns: readonly Turn[]): RouterState {
  const userTexts: string[] = [];
  const assistantSaid: string[] = [];
  const actions: Action[] = [];
  const pending = new Map<string, { step: number; tool: string; input: string }>();
  let step = 0;

  for (const m of turns) {
    if (m.role === "user") {
      const t = textOf(m.text);
      if (t) userTexts.push(t);
    } else if (m.role === "assistant") {
      const t = textOf(m.text);
      if (t) assistantSaid.push(clip(t, 300));
      for (const call of m.calls ?? []) {
        step += 1;
        pending.set(call.id, { step, tool: call.tool, input: clip(call.input, 500) });
      }
    } else {
      const call = pending.get(m.id) ?? { step: ++step, tool: m.tool ?? "unknown", input: "" };
      actions.push({ ...call, result: clip(m.output) });
    }
  }

  return fitState({ user_request: userTexts.join("\n---\n"), actions_taken: actions, assistant_said: assistantSaid }, stateCharMax());
}

/** Criteria for stage 1: one label per group, plus respond_to_user. */
function groupCriteria(groups: readonly GroupSpec[]): Record<string, string> {
  const criteria: Record<string, string> = { [RESPOND]: `${RESPOND_CRITERION.what} Not for: ${RESPOND_CRITERION.not_for}` };
  for (const group of groups) {
    const sample = group.tools.slice(0, GROUP_SAMPLE).map((t) => t.name).join(", ");
    const more = group.tools.length > GROUP_SAMPLE ? ` (+${group.tools.length - GROUP_SAMPLE} more)` : "";
    criteria[group.name] = clip(`Tools from ${group.name}: ${sample}${more}`, 300);
  }
  return criteria;
}

/** Cut the option list so options + respond_to_user fit within maxCount labels. */
export function limitOptions(options: readonly ToolSpec[], maxCount: number = MAX_OPTIONS): { options: readonly ToolSpec[]; truncated: boolean } {
  if (options.length + 1 <= maxCount) return { options, truncated: false };
  console.warn(
    `[jev] ${options.length} tools exceeds the ${maxCount}-label limit; keeping the first ${maxCount - 1}.`,
  );
  return { options: options.slice(0, maxCount - 1), truncated: true };
}

/** Jev may answer respond_to_user while work remains; require agreement from the done-noul. */
export function gate(
  tool: string,
  done: number,
  ranked: readonly (readonly [string, number])[],
): { tool: string; gated: boolean } {
  if (tool === RESPOND && done < doneThreshold()) {
    const next = ranked.find(([name]) => name !== RESPOND);
    if (next) return { tool: next[0], gated: true };
  }
  return { tool, gated: false };
}

/**
 * Offline stand-in for Jev (`JEV_STUB=1`): the first tool that has not run yet.
 * Only for smoke-testing the plumbing without an API key.
 */
export function stubDecision(state: RouterState, options: readonly ToolSpec[], truncated: boolean): RouterDecision {
  const used = new Set(state.actions_taken.map((a) => a.tool));
  const next = options.find((o) => !used.has(o.name));
  const tool = next?.name ?? RESPOND;
  return {
    tool,
    confidence: 0.99,
    done: tool === RESPOND ? 1 : 0,
    gated: false,
    top: [{ name: tool, p: 0.99 }],
    latencyMs: 0,
    state,
    truncated,
  };
}

export type Evaluator = (input: {
  state: EntryType;
  criteria: Record<string, string>;
  instructions: string;
  doneInstructions: string;
}) => Promise<{ choice: string; probabilities: Record<string, number>; confidence: number; done: number; usage?: { input_tokens: number; output_tokens: number } }>;

/** Ask Jev which tool to call next. */
export async function chooseNextTool(
  state: RouterState,
  allOptions: readonly ToolSpec[],
  evaluate: Evaluator = (input) => evaluateJev(input),
): Promise<RouterDecision> {
  const limit = Number(process.env.JEV_SINGLE_STAGE_MAX ?? 150);
  const hardMax = Number(process.env.JEV_LABEL_HARD_MAX ?? 190);
  // The provider rejects ~200 labels, so cut to the hard cap before counting.
  const { options, truncated } = limitOptions(allOptions, hardMax);
  if (process.env.JEV_STUB === "1") return stubDecision(state, options, truncated);

  const groups = groupTools(options);
  // Soft budget: too many labels, too many groups, or one oversized group for one reliable question.
  const maxGroupSize = Math.max(...groups.map((g) => g.tools.length));
  const twoStage = options.length + 1 > limit || groups.length + 1 > limit || maxGroupSize + 1 > limit;
  const started = performance.now();
  let group: string | undefined;
  let stage1Choice: string | undefined;
  let stageMs: number[] = [];
  let tokens: { in: number; out: number } | undefined;

  if (twoStage) {
    // Stage 1: pick the group. A failure here aborts classification; the proxy passes the request through.
    const t0 = performance.now();
    const answer1 = await evaluate({
      state: JSON.parse(JSON.stringify(state)) as EntryType,
      criteria: groupCriteria(groups), instructions: GROUP_INSTRUCTIONS, doneInstructions: DONE_INSTRUCTIONS,
    });
    stageMs.push(Math.round(performance.now() - t0));
    if (answer1.usage) tokens = { in: answer1.usage.input_tokens, out: answer1.usage.output_tokens };
    if (answer1.choice === RESPOND) {
      const done = answer1.done;
      const ranked: [string, number][] = [[RESPOND, answer1.probabilities[RESPOND] ?? answer1.confidence]];
      const top = ranked.slice(0, 5).map(([name, p]) => ({ name, p: Math.round(p * 1000) / 1000 }));
      const gated = gate(RESPOND, done, ranked);
      return { tool: gated.tool, confidence: answer1.confidence, done, gated: gated.gated, top, latencyMs: Math.round(performance.now() - started), state, truncated, group: undefined, stages: stageMs, tokens };
    }
    const chosen = groups.find((g) => g.name === answer1.choice) ?? groups.find((g) => g.tools.some((t) => t.name === answer1.choice));
    group = chosen?.name;
    stage1Choice = answer1.choice;
  }

  const criteria: Record<string, string> = {
    [RESPOND]: `${RESPOND_CRITERION.what} Not for: ${RESPOND_CRITERION.not_for}`,
  };
  let scope: readonly ToolSpec[] = options;
  if (twoStage) {
    if (group) scope = groups.filter((g) => g.name === group).flatMap((g) => g.tools);
    else {
      const byTool = stage1Choice ? groups.filter((g) => g.tools.some((t) => t.name === stage1Choice)).flatMap((g) => g.tools) : [];
      if (byTool.length > 0) scope = byTool;
    }
  }
  // A single oversized group defeats two-stage routing; the stage-2 criteria must still fit
  // the provider's hard label limit, so keep the first hardMax - 1 tools of the scope.
  if (scope.length + 1 > hardMax) scope = scope.slice(0, hardMax - 1);
  for (const o of scope) criteria[o.name] = clip(o.description ?? o.name, 300);
  const t1 = performance.now();
  const answer = await evaluate({
    state: JSON.parse(JSON.stringify(state)) as EntryType,
    criteria, instructions: INSTRUCTIONS, doneInstructions: DONE_INSTRUCTIONS,
  });
  stageMs.push(Math.round(performance.now() - t1));
  if (answer.usage) tokens = tokens ? { in: tokens.in + answer.usage.input_tokens, out: tokens.out + answer.usage.output_tokens } : { in: answer.usage.input_tokens, out: answer.usage.output_tokens };
  const latencyMs = Math.round(performance.now() - started);

  const done = answer.done;
  const ranked = Object.entries(answer.probabilities as Record<string, number>).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 5).map(([name, p]) => ({ name, p: Math.round(p * 1000) / 1000 }));
  const gated = gate(answer.choice, done, ranked);

  return { tool: gated.tool, confidence: answer.confidence, done, gated: gated.gated, top, latencyMs, state, truncated, group, stages: stageMs, tokens };
}
