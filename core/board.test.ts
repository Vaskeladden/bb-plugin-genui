import { describe, expect, it } from "vitest";
import {
  boardOrigin,
  boardSegments,
  boardSignal,
  chatLink,
  chatMessage,
  kindOf,
  lastUltrastatus,
  MAX_BOARD_VERSIONS,
  versionNumber,
  withVersion,
  type BoardKind,
  type BoardVersion,
} from "./board";

const publish = (
  versions: readonly BoardVersion[],
  id: string,
  mode: "update" | "new",
  title: string | null = null,
  kind: BoardKind = "ultrastatus",
): BoardVersion[] => withVersion(versions, { id, title, mode, kind, at: 1000 + versions.length, chat: null }).versions;

describe("a board's versions", () => {
  it("starts a board with the first version, whatever the mode", () => {
    const versions = publish([], "a", "update");
    expect(versions).toEqual([{ id: "a", board: "a", title: "Status", at: 1000, chat: null, kind: "ultrastatus" }]);
  });

  it("adds an update to the newest board and keeps its title", () => {
    const versions = publish(publish([], "a", "new", "Launch"), "b", "update");
    expect(versions.map(({ id, board, title }) => [id, board, title])).toEqual([
      ["a", "a", "Launch"],
      ["b", "a", "Launch"],
    ]);
  });

  it("starts another board on «new» and leaves the old one in the history", () => {
    const versions = publish(publish(publish([], "a", "new"), "b", "update"), "c", "new", "Second");
    expect(versions.map(({ id, board }) => [id, board])).toEqual([
      ["a", "a"],
      ["b", "a"],
      ["c", "c"],
    ]);
    expect(versionNumber(versions, "b")).toBe(2);
    expect(versionNumber(versions, "c")).toBe(1);
    expect(versionNumber(versions, "missing")).toBeNull();
  });

  it("an update can rename the board", () => {
    const versions = publish(publish([], "a", "new", "Old name"), "b", "update", "New name");
    expect(versions.at(-1)).toMatchObject({ board: "a", title: "New name" });
  });

  it("keeps the newest versions when the history is full and names the one that fell out", () => {
    let versions: BoardVersion[] = [];
    for (let index = 0; index < MAX_BOARD_VERSIONS; index++) versions = publish(versions, `v${index}`, "update");
    const next = withVersion(versions, { id: "last", title: null, mode: "update", kind: "ultrastatus", at: 5000, chat: null });
    expect(next.versions).toHaveLength(MAX_BOARD_VERSIONS);
    expect(next.versions[0]?.id).toBe("v1");
    expect(next.added.id).toBe("last");
    expect(next.dropped).toEqual(["v0"]);
  });

  it("drops the oldest update before any Ultrastatus when the history is full", () => {
    let versions: BoardVersion[] = [];
    for (let index = 0; index < MAX_BOARD_VERSIONS; index++) {
      versions = publish(versions, `v${index}`, "update", null, index % 2 === 0 ? "ultrastatus" : "update");
    }
    const next = withVersion(versions, { id: "last", title: null, mode: "update", kind: "update", at: 5000, chat: null });
    expect(next.dropped).toEqual(["v1"]);
    expect(next.versions.map(({ id }) => id).slice(0, 3)).toEqual(["v0", "v2", "v3"]);
    expect(next.versions.at(-1)).toMatchObject({ id: "last", kind: "update" });
  });

  it("keeps a new update even when every other version is an Ultrastatus", () => {
    let versions: BoardVersion[] = [];
    for (let index = 0; index < MAX_BOARD_VERSIONS; index++) versions = publish(versions, `v${index}`, "update");
    const next = withVersion(versions, { id: "last", title: null, mode: "update", kind: "update", at: 5000, chat: null });
    expect(next.dropped).toEqual(["v0"]);
    expect(next.versions.at(-1)?.id).toBe("last");
  });

  it("reads a version stored before kinds as an Ultrastatus", () => {
    expect(kindOf({ id: "a", board: "a", title: "Old", at: 1 })).toBe("ultrastatus");
  });

  it("finds the Ultrastatus an update builds on, within its own board", () => {
    const versions = publish(
      publish(publish(publish([], "a", "new", "Launch"), "b", "update", null, "update"), "c", "update", null, "update"),
      "d",
      "new",
      "Second",
      "update",
    );
    const byId = (id: string): BoardVersion => versions.find((version) => version.id === id)!;
    expect(lastUltrastatus(versions, byId("c"))?.id).toBe("a");
    expect(lastUltrastatus(versions, byId("a"))?.id).toBe("a");
    expect(lastUltrastatus(versions, byId("d"))).toBeNull();
  });
});

describe("a board's text", () => {
  it("splits prose from ui and app blocks and numbers each language's blocks", () => {
    const content = ["On track.", "", "```ui", 'Card("A", [])', "```", "", "Then:", "```app", "<p>x</p>", "```", "```ui", 'Card("B", [])', "```", "Last words."].join("\n");
    expect(boardSegments(content)).toEqual([
      { kind: "markdown", text: "On track." },
      { kind: "block", language: "ui", code: 'Card("A", [])', index: 0 },
      { kind: "markdown", text: "Then:" },
      { kind: "block", language: "app", code: "<p>x</p>", index: 0 },
      { kind: "block", language: "ui", code: 'Card("B", [])', index: 1 },
      { kind: "markdown", text: "Last words." },
    ]);
  });

  it("leaves other fenced code in the prose", () => {
    const content = ["Progress:", "```", "[███░░] A", "```", "```ui", "Text(1)", "```"].join("\n");
    expect(boardSegments(content)).toEqual([
      { kind: "markdown", text: "Progress:\n```\n[███░░] A\n```" },
      { kind: "block", language: "ui", code: "Text(1)", index: 0 },
    ]);
  });

  it("is empty for blank text", () => {
    expect(boardSegments("  \n")).toEqual([]);
  });
});

describe("the line above an answer picked on a board", () => {
  const versions = publish(publish(publish([], "a", "new", "Launch"), "b", "update"), "c", "new", "Second");

  it("names the board, the version, its time and the command that prints it", () => {
    expect(boardOrigin("thr_1", versions, "c", "21 Nov 14:11")).toBe(
      "From the status board «Second», version 1 of 21 Nov 14:11 (`bb genui board --version c` prints it):",
    );
  });

  it("says when the version is an update, which was not checked again", () => {
    const withUpdate = publish(versions, "d", "update", null, "update");
    expect(boardOrigin("thr_1", withUpdate, "d", "21 Nov 15:02")).toBe(
      "From the status board «Second», version 2 (an update, not checked again) of 21 Nov 15:02 (`bb genui board --version d` prints it):",
    );
  });

  it("says when the version is not the newest of its board", () => {
    const two = publish(publish([], "a", "new", "Launch"), "b", "update");
    expect(boardOrigin("thr_1", two, "a", "21 Nov 13:00")).toBe(
      "From the status board «Launch», version 1 of 21 Nov 13:00, not the newest (version 2 is) (`bb genui board --version a` prints it):",
    );
  });

  it("says when a newer board replaced it", () => {
    expect(boardOrigin("thr_1", versions, "b", "21 Nov 13:30")).toContain("version 2 of 21 Nov 13:30, an earlier board (");
  });

  it("links to where the chat stood when the version was made", () => {
    const made = withVersion(versions, { id: "d", title: null, mode: "update", kind: "ultrastatus", at: 4, chat: 412 }).versions;
    expect(boardOrigin("thr_1", made, "d", "21 Nov 15:00")).toBe(
      "From the status board «Second», version 2 of 21 Nov 15:00, made at @thread:thr_1#msg=412 (`bb genui board --version d` prints it):",
    );
    expect(chatLink("thr_1", made.at(-1)!)).toBe("@thread:thr_1#msg=412");
    // A version stored before boards recorded the chat has no link.
    expect(chatLink("thr_1", { id: "x", board: "x", title: "Old", at: 1 })).toBeNull();
  });

  it("is nothing for a version the thread no longer has", () => {
    expect(boardOrigin("thr_1", versions, "gone", "now")).toBeNull();
  });
});

describe("the newest chat message among a thread's events", () => {
  const reply = (seq: number, type: string) => ({ seq, type: "item/completed", data: { item: { type } } });

  it("is the newest finished reply or message sent to the thread", () => {
    expect(chatMessage([reply(9, "commandExecution"), reply(8, "agentMessage"), { seq: 3, type: "client/turn/requested" }])).toBe(8);
    expect(chatMessage([reply(9, "reasoning"), { seq: 7, type: "client/turn/requested", data: {} }, reply(5, "agentMessage")])).toBe(7);
  });

  it("is nothing when the events hold no message", () => {
    expect(chatMessage([])).toBeNull();
    expect(chatMessage([reply(9, "toolCall"), { seq: 8, type: "item/completed" }, { seq: 7, type: "item/completed", data: null }])).toBeNull();
  });
});

describe("a publish's announcement", () => {
  it("names the thread and the version", () => {
    expect(boardSignal({ threadId: "thr_1", id: "abc" })).toEqual({ threadId: "thr_1", id: "abc" });
  });

  it("is nothing for another payload", () => {
    expect(boardSignal(null)).toBeNull();
    expect(boardSignal({ threadId: "thr_1" })).toBeNull();
    expect(boardSignal("thr_1")).toBeNull();
  });
});
