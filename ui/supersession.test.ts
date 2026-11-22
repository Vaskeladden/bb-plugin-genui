import { describe, expect, it } from "vitest";
import { affectsConversation, hasLaterUserMessage, isMachineMessage, type OutlineItem } from "./supersession";

// Ids as BB's conversation outline and timeline rows write them.
const ASK = "thr_a:assistant:kind:assistant|turn:t12|parent:root|item:i20";
const LATEST = "thr_a:assistant:kind:assistant|turn:t20|parent:root|item:i38";
const OUTLINE: readonly OutlineItem[] = [
  { id: "thr_a:user-seed:1", role: "user" },
  { id: ASK, role: "assistant" },
  { id: "thr_a:user-seed:40", role: "user" },
  { id: LATEST, role: "assistant" },
];

describe("hasLaterUserMessage", () => {
  it("is true for a reply the user has answered since", () => {
    expect(hasLaterUserMessage(OUTLINE, ASK)).toBe(true);
  });

  it("is false while the reply is the latest exchange", () => {
    expect(hasLaterUserMessage(OUTLINE, LATEST)).toBe(false);
  });

  it("ignores later assistant messages of the same turn", () => {
    const outline: OutlineItem[] = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "a2", role: "assistant" },
    ];
    expect(hasLaterUserMessage(outline, "a1")).toBe(false);
  });

  it("does not count user messages before the reply", () => {
    expect(hasLaterUserMessage([{ id: "u1", role: "user" }, { id: "a1", role: "assistant" }], "a1")).toBe(false);
  });

  it("ignores a user row listed out of sequence, like BB's rejected steer at the end", () => {
    const stale: OutlineItem = { id: "thr_a:user-seed:30", role: "user" };
    expect(hasLaterUserMessage([...OUTLINE, stale], LATEST)).toBe(false);
    expect(hasLaterUserMessage([...OUTLINE, stale, { id: "thr_a:user-seed:50", role: "user" }], LATEST)).toBe(true);
  });

  it("keeps a reply open when only machine messages follow it", () => {
    const outline: OutlineItem[] = [
      { id: "thr_a:user-seed:1", role: "user" },
      { id: ASK, role: "assistant" },
      { id: "thr_a:user-seed:40", role: "user", machine: true },
      { id: LATEST, role: "assistant" },
      { id: "thr_a:user-seed:60", role: "user", machine: true },
    ];
    expect(hasLaterUserMessage(outline, ASK)).toBe(false);
    expect(hasLaterUserMessage([...outline, { id: "thr_a:user-seed:70", role: "user" }], ASK)).toBe(true);
  });

  it("is unknown when the outline is not loaded or lacks the reply", () => {
    expect(hasLaterUserMessage(null, ASK)).toBeNull();
    expect(hasLaterUserMessage(OUTLINE, "thr_a:assistant:nested")).toBeNull();
  });
});

describe("isMachineMessage", () => {
  it("knows the messages bb, plugins and other threads send for the user", () => {
    for (const preview of [
      "[ci watcher] ✅ CI is green on bb#230 (129615a)",
      "[run watcher] deploy finished",
      "[ship keeper] Continue /pr-shipit for this PR.",
      "[bb system]\n\n@thread:thr_x completed:",
      "[bb message from thread:thr_73auicgny8] done",
      "Please continue.",
      "Give a short status report in exactly this format, then stop",
    ]) {
      expect(isMachineMessage(preview), preview).toBe(true);
    }
  });

  it("leaves what the user wrote alone", () => {
    for (const preview of ["shipit", "Hva skal skje? shipit · merge", "go 1,2", "see [the docs](https://x.test) first", "[1] is wrong", ""]) {
      expect(isMachineMessage(preview), preview).toBe(false);
    }
  });
});

describe("affectsConversation", () => {
  const appended = (...eventTypes: string[]) => ({ changes: ["events-appended"], metadata: { eventTypes } });

  it("re-reads when a user message is requested or accepted", () => {
    expect(affectsConversation(appended("client/turn/requested"))).toBe(true);
    expect(affectsConversation(appended("item/agentMessage/delta", "turn/input/accepted"))).toBe(true);
  });

  it("skips streaming and tool progress", () => {
    expect(affectsConversation(appended("item/agentMessage/delta"))).toBe(false);
    expect(affectsConversation(appended("item/started", "item/completed", "thread/tokenUsage/updated"))).toBe(false);
  });

  it("re-reads appends of unknown events and rewritten history", () => {
    expect(affectsConversation({ changes: ["events-appended"] })).toBe(true);
    expect(affectsConversation({ changes: ["history-rewritten"] })).toBe(true);
  });

  it("skips changes that leave the messages alone", () => {
    expect(affectsConversation({ changes: ["status-changed", "title-changed", "read-state-changed"] })).toBe(false);
  });
});
