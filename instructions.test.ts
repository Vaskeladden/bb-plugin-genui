import { describe, expect, it } from "vitest";
import { ACTIONS, COMPONENTS } from "./core/catalog";
import { collectLoads, compile, dataKey, evaluate, formatDiagnostics, initialState, type LoadedData } from "./core";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_WEB_OFF,
  BOARD_BY_COPY_INSTRUCTIONS,
  BOARD_COPY_REQUEST,
  BOARD_LAYOUT,
  BOARD_START_INSTRUCTIONS,
  BOARD_START_REQUEST,
  BOARD_UPKEEP_INSTRUCTIONS,
  CODE_WORK_INSTRUCTIONS,
  copyInstructions,
  UI_REFERENCE,
  UI_REFERENCE_MORE,
  WEB_LOOKUPS_OFF,
} from "./instructions";

describe("agent instructions", () => {
  // BB refuses a tool whose instructions pass 4096 characters (the plugin then
  // fails to load) and truncates the configure and contributed sections there.
  it("fit BB's 4096-character cap per section", () => {
    expect(AGENT_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(AGENT_INSTRUCTIONS_WEB_OFF.length).toBeLessThanOrEqual(4096);
    expect(CODE_WORK_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(BOARD_UPKEEP_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(BOARD_START_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(BOARD_START_REQUEST.length).toBeLessThanOrEqual(4096);
    expect(BOARD_BY_COPY_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(BOARD_COPY_REQUEST.length).toBeLessThanOrEqual(4096);
    expect(copyInstructions("thr_abcdefghij").length).toBeLessThanOrEqual(4096);
    expect(BOARD_LAYOUT.length).toBeLessThanOrEqual(4096);
    expect(UI_REFERENCE.length).toBeLessThanOrEqual(4096);
    expect(UI_REFERENCE_MORE.length).toBeLessThanOrEqual(4096);
  });

  // A replace that silently matches nothing would keep teaching Map while lookups are off.
  it("swap the Map example for the off note while web lookups are off", () => {
    expect(AGENT_INSTRUCTIONS_WEB_OFF).toContain(WEB_LOOKUPS_OFF);
    expect(AGENT_INSTRUCTIONS_WEB_OFF).not.toContain("Map(");
  });

  // The Evidence group's signatures ride on the code-work section, which every session that gets the references also gets.
  it("list every component and action the parser accepts", () => {
    const reference = `${UI_REFERENCE}\n${UI_REFERENCE_MORE}\n${CODE_WORK_INSTRUCTIONS}`;
    for (const name of [...Object.keys(COMPONENTS), ...Object.keys(ACTIONS)]) {
      expect(reference, name).toContain(`${name}(`);
    }
  });

  it("carry examples that compile and render without errors", () => {
    const examples = [...`${AGENT_INSTRUCTIONS}\n${CODE_WORK_INSTRUCTIONS}`.matchAll(/```ui\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThan(3);
    for (const example of examples) {
      const compiled = compile(example);
      expect(formatDiagnostics(compiled.diagnostics), example).toBe("");
      const program = compiled.program!;
      // Example paths are illustrative: each Load reads as an empty report.
      const data = new Map<string, LoadedData>(collectLoads(program).map((request) => [dataKey(request), { ok: true, value: [] }]));
      const { diagnostics } = evaluate(program, initialState(program, data), data);
      expect(diagnostics, example).toEqual([]);
    }
  });
});

describe("bug tracker on the status board", () => {
  const STAGES = ["Cause found", "Fix chosen", "Solved and proven", "Reviewed and merged", "Live", "Checked on the real case", "Reporter told"];

  // Every other board keeps its bar: the tracker replaces it on a bug thread only.
  it("leaves the bar of every other board as it was", () => {
    expect(BOARD_LAYOUT).toContain("2. One bar of the whole job. On a bug thread, the bug tracker instead.");
    expect(BOARD_LAYOUT).toContain("On such a thread only, the bar's place holds one Card with Steps");
  });

  it("names the seven stages in their order", () => {
    const list = BOARD_LAYOUT.match(/in the user's language: ([^.]+)\./)?.[1];
    expect(list?.split(", ")).toEqual(STAGES);
  });

  // The owner reads the tracker to see whether a bug is really solved, so done needs its proof.
  it("calls a stage done only with its proof", () => {
    expect(BOARD_LAYOUT).toContain("A stage is done only when the thread's work shows its proof, and its detail gives that proof in one line");
    expect(BOARD_LAYOUT).toContain("No proof: current or not started, never done, even when you believe it.");
    expect(BOARD_LAYOUT).toContain("«Solved, waiting for: <first stage not done>» once Solved and proven is done, else «Still solving: <first stage not done>»");
  });

  // The example is what a writer copies: it must render, keep the seven stages and give every done stage its proof line.
  it("carries an example tracker that renders and gives every done stage its proof", () => {
    const example = BOARD_LAYOUT.match(/```ui\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    const compiled = compile(example!);
    expect(formatDiagnostics(compiled.diagnostics), example).toBe("");
    const data = new Map<string, LoadedData>();
    expect(evaluate(compiled.program!, initialState(compiled.program!, data), data).diagnostics).toEqual([]);
    const steps = [...example!.matchAll(/\{title: "([^"]+)"(?:, status: "(\w+)")?(?:, detail: "([^"]*)")?\}/g)];
    expect(steps.map((step) => step[1])).toEqual(STAGES);
    for (const [, title, status, detail] of steps) if (status === "done") expect(detail?.trim(), title).toBeTruthy();
    expect(example).toContain('Card("Solved, waiting for: Reviewed and merged"');
  });
});
