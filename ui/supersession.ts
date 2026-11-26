// Pure rules behind useSuperseded: whether a reply has been answered, and
// which thread changes can change that. No React, no DOM, no SDK.

/** One message of BB's conversation outline (`sdk.threads.conversationOutline`), in thread order. */
export interface OutlineItem {
  readonly id: string;
  readonly role: "assistant" | "user";
  /** A user row the user did not write (see `isMachineMessage`): it answers nothing. */
  readonly machine?: boolean;
}

/**
 * A leading «[tag] » marks a message bb, a plugin or another thread sent in
 * the user's name: «[ci watcher] …», «[run watcher] …», «[ship keeper] …»,
 * «[bb system] …», «[bb message from thread:…] …».
 */
const MACHINE_TAG = /^\s*\[[a-z][^\]\n]{0,80}\]\s/i;

/**
 * Fixed prompts sent without a tag: bb's retry after a provider error, and
 * the jb-flow buttons that ask the agent for a report. vaskeladden-bb's ship
 * keeper keeps the same list (`lib/ship-keeper.ts`) for the same reason.
 */
const MACHINE_OPENINGS: readonly string[] = [
  "Please continue.",
  "Give a short status report in exactly this format",
  "Ultrastatus: give me a thorough, checked status report",
  "What is the real problem here? Explain it to me like I'm a donkey",
  "⏰ Snooze reminder:",
  "released: ",
  "The release merged (",
];

/**
 * Whether a user row is a message sent for the user, not written by them,
 * judged from the start of its text (the outline's `preview`). bb records
 * plugin messages with the user as initiator, so the text is the only sign.
 * Such a message is news for the agent, not the user's answer: the questions
 * before it stay open.
 */
export function isMachineMessage(preview: string): boolean {
  if (MACHINE_TAG.test(preview)) return true;
  const text = preview.trimStart();
  return MACHINE_OPENINGS.some((opening) => text.startsWith(opening));
}

/** A user row's event sequence, from its `<thread>:user-seed:<seq>` id; null for any other id. */
function userSeq(id: string): number | null {
  const match = /:user-seed:(\d+)$/.exec(id);
  return match === null ? null : Number(match[1]);
}

/**
 * Whether a message the user wrote follows the message `anchorId` (the
 * assistant reply holding a block). Machine rows do not count. Null when the
 * anchor is not in the outline, so the caller can keep what it knew: a nested
 * agent's message, or a reply the outline no longer lists.
 *
 * A user row whose sequence is below one already seen is out of place, not a
 * reply: BB's outline can list a rejected steer, sent long before, at its end.
 */
export function hasLaterUserMessage(items: readonly OutlineItem[] | null, anchorId: string): boolean | null {
  if (items === null) return null;
  const anchor = items.findIndex((item) => item.id === anchorId);
  if (anchor === -1) return null;
  let highest = -1;
  for (const [index, item] of items.entries()) {
    if (item.role !== "user") continue;
    const seq = userSeq(item.id);
    if (seq !== null && seq < highest) continue;
    if (index > anchor && item.machine !== true) return true;
    if (seq !== null) highest = seq;
  }
  return false;
}

/** How many of the newest unanswered replies are looked at for questions. */
const MAX_OPEN_REPLIES = 20;

/** The replies whose questions may still be open, and how far back in the thread they reach. */
export interface OpenReplies {
  /** Assistant message ids, oldest first. */
  readonly ids: readonly string[];
  /** User rows (the user's own last message and the machine messages since) from the oldest of them to the end. */
  readonly turns: number;
}

/**
 * The assistant replies the user has not answered: those after the last
 * message the user wrote (by the rules of `hasLaterUserMessage`). The replies
 * of the newest turn count only with `newest` (the turn has finished): while
 * it runs, its text is still being written.
 */
export function openReplies(items: readonly OutlineItem[] | null, { newest = true }: { newest?: boolean } = {}): OpenReplies {
  if (items === null) return { ids: [], turns: 0 };
  let highest = -1;
  let written = -1;
  let newestUser = -1;
  items.forEach((item, index) => {
    if (item.role !== "user") return;
    const seq = userSeq(item.id);
    if (seq !== null && seq < highest) return;
    if (item.machine !== true) written = index;
    newestUser = index;
    if (seq !== null) highest = seq;
  });
  const open: number[] = [];
  const end = newest ? items.length : newestUser;
  for (let index = written + 1; index < end; index++) if (items[index]?.role === "assistant") open.push(index);
  const kept = open.slice(-MAX_OPEN_REPLIES);
  const first = kept[0];
  if (first === undefined) return { ids: [], turns: 0 };
  // The turn holding the oldest kept reply starts at the user row before it.
  const turns = 1 + items.slice(first).filter((item) => item.role === "user").length;
  return { ids: kept.map((index) => items[index]!.id), turns };
}

/** The part of BB's `thread:changed` realtime event this module reads. */
export interface ThreadChange {
  readonly changes: readonly string[];
  readonly metadata?: { readonly eventTypes?: readonly string[] };
}

/**
 * Thread events that add, accept, reject or drop a user message. Every user
 * message (typed, sent by a plugin or the CLI, dispatched from the queue)
 * enters as `client/turn/requested`; the rest cover steering, manager
 * messages and context resets.
 */
const CONVERSATION_EVENTS: Readonly<Record<string, true>> = {
  "client/thread/start": true,
  "client/turn/requested": true,
  "client/turn/rejected": true,
  "client/turn/start": true,
  "turn/input/accepted": true,
  "turn/started": true,
  "system/manager/user_message": true,
  "thread/context/cleared": true,
  "thread/compacted": true,
};

/**
 * Whether a change can move a user message in or out of the outline, so it
 * must be read again. Streaming deltas and tool progress never can, which
 * keeps a running reply from refetching on every token.
 */
export function affectsConversation(change: ThreadChange): boolean {
  return change.changes.some((kind) => {
    if (kind === "history-rewritten" || kind === "history-compacted") return true;
    if (kind !== "events-appended") return false;
    const types = change.metadata?.eventTypes;
    // An append that doesn't say what it appended may be anything.
    return types === undefined || types.some((type) => Object.hasOwn(CONVERSATION_EVENTS, type));
  });
}
