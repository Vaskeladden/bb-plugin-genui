// The status board: a report an agent puts in its thread's side panel with the
// show_board tool, instead of in a reply that scrolls away. A board keeps every
// version it was given, so each one is a point in time the user can go back to.
// Pure rules only: what a version is, how a new one joins the history, and how
// a board's text is split into prose and blocks. No SDK, no React.
import { findFences } from "./fences";

/** "update" adds a version to the board the thread shows; "new" starts another board. */
export type BoardMode = "update" | "new";

/** One version of a board, as it was when the agent published it; its text is stored beside it. */
export interface BoardVersion {
  /** Unique within the thread. */
  readonly id: string;
  /** The board this version belongs to: the id of the board's first version. */
  readonly board: string;
  readonly title: string;
  /** When it was published, in epoch milliseconds. */
  readonly at: number;
}

export const DEFAULT_BOARD_TITLE = "Status";
/** A board's text (markdown with ```ui and ```app blocks); a thorough report with a dozen blocks is a tenth of this. */
export const MAX_BOARD_CHARS = 60_000;
export const MAX_BOARD_TITLE_CHARS = 80;
/** Versions kept per thread, across its boards; the oldest go first. */
export const MAX_BOARD_VERSIONS = 30;

/**
 * The thread's versions, oldest first, after publishing one more, and the ids
 * that fell out of the history. An update joins the newest version's board and
 * keeps its title unless one is given; the first version of a thread, or mode
 * "new", starts a board.
 */
export function withVersion(
  versions: readonly BoardVersion[],
  published: { readonly id: string; readonly title: string | null; readonly mode: BoardMode; readonly at: number },
): { readonly versions: BoardVersion[]; readonly added: BoardVersion; readonly dropped: string[] } {
  const newest = versions.at(-1);
  const joins = published.mode === "update" && newest !== undefined;
  const added: BoardVersion = {
    id: published.id,
    board: joins ? newest.board : published.id,
    title: published.title ?? (joins ? newest.title : DEFAULT_BOARD_TITLE),
    at: published.at,
  };
  const all = [...versions, added];
  const kept = all.slice(-MAX_BOARD_VERSIONS);
  return { versions: kept, added, dropped: all.slice(0, all.length - kept.length).map((version) => version.id) };
}

/** Which version of its board this one is, counted from 1 among the versions still kept. */
export function versionNumber(versions: readonly BoardVersion[], id: string): number | null {
  const version = versions.find((candidate) => candidate.id === id);
  if (version === undefined) return null;
  const siblings = versions.filter((candidate) => candidate.board === version.board);
  return siblings.findIndex((candidate) => candidate.id === id) + 1;
}

export type BoardSegment =
  | { readonly kind: "markdown"; readonly text: string }
  /** `index` counts the block among the board's blocks of its language, as BB counts a reply's. */
  | { readonly kind: "block"; readonly language: "ui" | "app"; readonly code: string; readonly index: number };

/** A board's text as the prose and the ```ui / ```app blocks it holds, in order. Other fences stay in the prose. */
export function boardSegments(content: string): BoardSegment[] {
  const lines = content.split("\n");
  const segments: BoardSegment[] = [];
  const counts = { ui: 0, app: 0 };
  let from = 0;
  const prose = (to: number): void => {
    const text = lines.slice(from, to).join("\n").trim();
    if (text !== "") segments.push({ kind: "markdown", text });
  };
  for (const fence of findFences(lines)) {
    if (fence.language !== "ui" && fence.language !== "app") continue;
    prose(fence.open);
    segments.push({ kind: "block", language: fence.language, code: fence.body, index: counts[fence.language]++ });
    from = fence.close + 1;
  }
  prose(lines.length);
  return segments;
}

/**
 * The line above answers picked on a board version, in the user's message:
 * which board and version they answer, since the chat they land in may have
 * moved on after it was published, and the command that prints that version.
 * `published` is the version's time as the user reads it; null when `id` is
 * not one of `versions`.
 */
export function boardOrigin(versions: readonly BoardVersion[], id: string, published: string): string | null {
  const version = versions.find((candidate) => candidate.id === id);
  const number = versionNumber(versions, id);
  const newest = versions.at(-1);
  if (version === undefined || number === null || newest === undefined) return null;
  const newer = newest.id === id ? "" : newest.board === version.board ? `, not the newest (version ${versionNumber(versions, newest.id)} is)` : ", an earlier board";
  return `From the status board «${version.title}», version ${number} of ${published}${newer} (\`bb genui board --version ${id}\` prints it):`;
}

/** What a publish announces on the realtime channel; null for anything else on it. */
export function boardSignal(payload: unknown): { readonly threadId: string; readonly id: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { threadId, id } = payload as { threadId?: unknown; id?: unknown };
  return typeof threadId === "string" && typeof id === "string" ? { threadId, id } : null;
}
