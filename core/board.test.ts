import { describe, expect, it } from "vitest";
import { boardSegments, boardSignal, MAX_BOARD_VERSIONS, versionNumber, withVersion, type BoardVersion } from "./board";

const publish = (versions: readonly BoardVersion[], id: string, mode: "update" | "new", title: string | null = null): BoardVersion[] =>
  withVersion(versions, { id, title, mode, at: 1000 + versions.length }).versions;

describe("a board's versions", () => {
  it("starts a board with the first version, whatever the mode", () => {
    const versions = publish([], "a", "update");
    expect(versions).toEqual([{ id: "a", board: "a", title: "Status", at: 1000 }]);
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
    const next = withVersion(versions, { id: "last", title: null, mode: "update", at: 5000 });
    expect(next.versions).toHaveLength(MAX_BOARD_VERSIONS);
    expect(next.versions[0]?.id).toBe("v1");
    expect(next.added.id).toBe("last");
    expect(next.dropped).toEqual(["v0"]);
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
