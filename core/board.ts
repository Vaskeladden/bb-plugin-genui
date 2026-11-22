// The status board: a report an agent puts in its thread's side panel with the
// show_board tool, instead of in a reply that scrolls away. A board keeps every
// version it was given, so each one is a point in time the user can go back to.
// Pure rules only: what a version is, how a new one joins the history, and how
// a board's text is split into prose and blocks. No SDK, no React.
import { findFences } from "./fences";

/** "update" adds a version to the board the thread shows; "new" starts another board. */
export type BoardMode = "update" | "new";

/**
 * What a version is worth. "ultrastatus": a thorough report that checked every
 * row again, as an Ultrastatus request asks. "update": the agent brought the
 * board up to date from its own work, without checking every row again. An
 * update never counts as an Ultrastatus.
 */
export type BoardKind = "ultrastatus" | "update";

/** One version of a board, as it was when the agent published it; its text is stored beside it. */
export interface BoardVersion {
  /** Unique within the thread. */
  readonly id: string;
  /** The board this version belongs to: the id of the board's first version. */
  readonly board: string;
  readonly title: string;
  /** When it was published, in epoch milliseconds. */
  readonly at: number;
  /**
   * The chat message it was published after: the `msg` of an
   * `@thread:<id>#msg=<n>` link. Null when the thread had none to find;
   * absent on versions stored before boards recorded it.
   */
  readonly chat?: number | null;
  /** Absent on versions stored before boards recorded it: those were all Ultrastatus reports. */
  readonly kind?: BoardKind;
}

export function kindOf(version: BoardVersion): BoardKind {
  return version.kind ?? "ultrastatus";
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
 * "new", starts a board. A full history drops its oldest kind "update" first,
 * so the frequent small updates never push the Ultrastatus reports out.
 */
export function withVersion(
  versions: readonly BoardVersion[],
  published: {
    readonly id: string;
    readonly title: string | null;
    readonly mode: BoardMode;
    readonly kind: BoardKind;
    readonly at: number;
    readonly chat: number | null;
  },
): { readonly versions: BoardVersion[]; readonly added: BoardVersion; readonly dropped: string[] } {
  const newest = versions.at(-1);
  const joins = published.mode === "update" && newest !== undefined;
  const added: BoardVersion = {
    id: published.id,
    board: joins ? newest.board : published.id,
    title: published.title ?? (joins ? newest.title : DEFAULT_BOARD_TITLE),
    at: published.at,
    chat: published.chat,
    kind: published.kind,
  };
  const kept = [...versions, added];
  const dropped: string[] = [];
  while (kept.length > MAX_BOARD_VERSIONS) {
    // The version just added always stays.
    const update = kept.findIndex((version, index) => index < kept.length - 1 && kindOf(version) === "update");
    dropped.push(...kept.splice(update === -1 ? 0 : update, 1).map((version) => version.id));
  }
  return { versions: kept, added, dropped };
}

/** The newest Ultrastatus version of the board `version` belongs to, up to and including it; null when the history keeps none. */
export function lastUltrastatus(versions: readonly BoardVersion[], version: BoardVersion): BoardVersion | null {
  const upTo = versions.slice(0, versions.findIndex((candidate) => candidate.id === version.id) + 1);
  return [...upTo].reverse().find((candidate) => candidate.board === version.board && kindOf(candidate) === "ultrastatus") ?? null;
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

/** A thread event as BB lists it, as far as a board reads one. */
export interface ChatEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

/** The event types `chatMessage` reads; ask BB for these only. */
export const CHAT_MESSAGE_EVENTS = ["client/turn/requested", "item/completed"] as const;

/**
 * The newest chat message among a thread's events, newest first: a message
 * sent to the thread, or a finished reply of its agent. Its `seq` is what an
 * `@thread:<id>#msg=<n>` link names. Null when the events hold none.
 */
export function chatMessage(events: readonly ChatEvent[]): number | null {
  for (const event of events) {
    if (event.type === "client/turn/requested") return event.seq;
    if (event.type !== "item/completed" || typeof event.data !== "object" || event.data === null) continue;
    const { item } = event.data as { item?: unknown };
    if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "agentMessage") return event.seq;
  }
  return null;
}

/** Where the chat stood when a version was published, as a link BB and `bb thread log --message` read; null when not recorded. */
export function chatLink(threadId: string, version: BoardVersion): string | null {
  return typeof version.chat === "number" ? `@thread:${threadId}#msg=${version.chat}` : null;
}

/**
 * The line above answers picked on a board version, in the user's message:
 * which board and version they answer, since the chat they land in may have
 * moved on after it was published; where the chat stood then, when the version
 * recorded it; and the command that prints that version. `published` is the
 * version's time as the user reads it; null when `id` is not one of `versions`.
 */
export function boardOrigin(threadId: string, versions: readonly BoardVersion[], id: string, published: string): string | null {
  const version = versions.find((candidate) => candidate.id === id);
  const number = versionNumber(versions, id);
  const newest = versions.at(-1);
  if (version === undefined || number === null || newest === undefined) return null;
  const newer = newest.id === id ? "" : newest.board === version.board ? `, not the newest (version ${versionNumber(versions, newest.id)} is)` : ", an earlier board";
  const link = chatLink(threadId, version);
  const made = link === null ? "" : `, made at ${link}`;
  const kind = kindOf(version) === "update" ? " (an update, not checked again)" : "";
  return `From the status board «${version.title}», version ${number}${kind} of ${published}${newer}${made} (\`bb genui board --version ${id}\` prints it):`;
}

/** What a publish announces on the realtime channel; null for anything else on it. */
export function boardSignal(payload: unknown): { readonly threadId: string; readonly id: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { threadId, id } = payload as { threadId?: unknown; id?: unknown };
  return typeof threadId === "string" && typeof id === "string" ? { threadId, id } : null;
}
