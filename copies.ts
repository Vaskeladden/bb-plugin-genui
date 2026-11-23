// Background copies: hidden forks of a thread that write its status board, so
// the thread's own agent is never interrupted for a status.
//
// A copy clones the thread's conversation up to its last finished turn, runs
// one request (bring the board up to date, a Status, an Ultrastatus) in the
// same folder, publishes to the thread's board (show_board and the CLI follow
// `sourceOf`) and is put away when it goes idle: a board copy deleted, a
// Status or Ultrastatus copy archived so its report can still be read. After a
// turn of a thread a person reads, one copy updates its board, at most once per
// BOARD_GAP_MS: a turn that ends sooner, or while a copy for that thread still
// runs, gets one update when the gap is over, which covers every turn since.
// Each copy re-reads the whole conversation, so the gap is what keeps a busy
// thread from costing a copy per turn.
// A thread whose agent can't be forked (bb refuses the fork) keeps doing its
// board itself: `canCopy` says so, and the instructions follow it.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BOARD_COPY_REQUEST } from "./instructions";

export const COPY_PURPOSES = ["board", "status", "ultra"] as const;
export type CopyPurpose = (typeof COPY_PURPOSES)[number];

/** A thread id as bb writes it; a copy's source comes from thread metadata, which anyone can write. */
export const THREAD_ID = /^thr_[a-z0-9]{3,40}$/;

const TITLES: Record<CopyPurpose, string> = {
  board: "Board update (background copy)",
  status: "Status (background copy)",
  ultra: "Ultrastatus (background copy)",
};

/** A copy that never went idle (its agent died, bb restarted) stops blocking the next one after this long. */
export const COPY_STALE_MS = 30 * 60_000;
/** The shortest time between two board updates of one thread. */
export const BOARD_GAP_MS = 10 * 60_000;
/** How long a refused fork keeps a thread on doing its board itself before it is tried again. */
export const NO_COPY_MS = 24 * 60 * 60_000;

const recordSchema = z.object({ sourceId: z.string().regex(THREAD_ID), purpose: z.enum(COPY_PURPOSES), at: z.number() });
type CopyRecord = z.infer<typeof recordSchema>;

export type CopyResult = { ok: true; copyId: string } | { ok: false; message: string };

export function createCopies(bb: BbPluginApi, { isPersonThread }: { isPersonThread: (threadId: string) => boolean }) {
  /** copy id → its record; mirrored in kv so a reload still knows its copies. */
  const known = new Map<string, CopyRecord>();
  /** source id → the copy running for it and when it started. */
  const running = new Map<string, { copyId: string; at: number }>();
  /** Sources whose turn ended while their copy ran: one more board update after it. */
  const again = new Set<string>();
  /** source id → when its last board copy started. */
  const lastBoard = new Map<string, number>();
  /** source id → the timer of its board update due when the gap is over; mirrored in kv so a reload keeps it. */
  const due = new Map<string, ReturnType<typeof setTimeout>>();
  /** source id → when bb last refused to fork it. */
  const refused = new Map<string, number>();
  const copyKey = (id: string) => `copy:${id}`;
  const refusedKey = (id: string) => `noCopy:${id}`;
  const dueKey = (id: string) => `boardDue:${id}`;
  const error = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  async function recordOf(copyId: string): Promise<CopyRecord | null> {
    const cached = known.get(copyId);
    if (cached !== undefined) return cached;
    const parsed = recordSchema.safeParse(await bb.storage.kv.get(copyKey(copyId)));
    if (!parsed.success) return null;
    known.set(copyId, parsed.data);
    return parsed.data;
  }

  async function run(sourceId: string, text: string, purpose: CopyPurpose): Promise<CopyResult> {
    if (!THREAD_ID.test(sourceId)) return { ok: false, message: `not a thread id: ${sourceId}` };
    let copyId: string;
    try {
      const copy = await bb.sdk.threads.fork({
        sourceThreadId: sourceId,
        visibility: "hidden",
        lifecycleOwnerThreadId: sourceId,
        title: TITLES[purpose],
        pluginMetadata: { copyOf: sourceId, purpose },
        input: [{ type: "text", text, mentions: [] }],
      });
      copyId = copy.id;
    } catch (cause) {
      const at = Date.now();
      refused.set(sourceId, at);
      await bb.storage.kv.set(refusedKey(sourceId), { at }).catch(() => {});
      bb.log.warn(`copy: could not fork ${sourceId} for ${purpose}: ${error(cause)}`);
      return { ok: false, message: error(cause) };
    }
    const record = { sourceId, purpose, at: Date.now() };
    known.set(copyId, record);
    running.set(sourceId, { copyId, at: record.at });
    if (purpose === "board") lastBoard.set(sourceId, record.at);
    refused.delete(sourceId);
    await bb.storage.kv.set(copyKey(copyId), record);
    await bb.storage.kv.delete(refusedKey(sourceId)).catch(() => {});
    return { ok: true, copyId };
  }

  /**
   * One board update for a thread whose turn ended: now, or when the gap since its last one is over,
   * or after the copy that still runs for it. One planned update covers every turn before it.
   */
  async function updateBoard(sourceId: string): Promise<void> {
    if (due.has(sourceId)) return;
    const busy = running.get(sourceId);
    if (busy !== undefined && Date.now() - busy.at < COPY_STALE_MS) {
      again.add(sourceId);
      return;
    }
    running.delete(sourceId);
    const at = (lastBoard.get(sourceId) ?? 0) + BOARD_GAP_MS;
    if (at > Date.now()) {
      await planBoard(sourceId, at);
      return;
    }
    await run(sourceId, BOARD_COPY_REQUEST, "board");
  }

  async function planBoard(sourceId: string, at: number): Promise<void> {
    if (due.has(sourceId)) return;
    const timer = setTimeout(() => {
      due.delete(sourceId);
      void (async () => {
        try {
          await bb.storage.kv.delete(dueKey(sourceId));
          if (!canCopy(sourceId)) return;
          // The thread may have been archived or deleted while the update waited.
          const thread = await bb.sdk.threads.get({ threadId: sourceId });
          if (thread.archivedAt !== null) return;
          await updateBoard(sourceId);
        } catch (cause) {
          bb.log.warn(`copy: planned board update of ${sourceId} failed: ${error(cause)}`);
        }
      })();
    }, Math.max(0, at - Date.now()));
    due.set(sourceId, timer);
    await bb.storage.kv.set(dueKey(sourceId), { at }).catch(() => {});
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    try {
      const record = await recordOf(thread.id);
      if (record !== null) {
        // A copy created with its request never idles before that request has run; an empty
        // reply (only tool calls) still ends it.
        if (lastAssistantText === null && Date.now() - record.at < 5_000) return;
        if (running.get(record.sourceId)?.copyId === thread.id) running.delete(record.sourceId);
        known.delete(thread.id);
        await bb.storage.kv.delete(copyKey(thread.id));
        // A board copy is done once it published: deleted, or one hidden thread would pile up per turn.
        // A Status or Ultrastatus copy is archived: the thread's agent reads its report when the user answers it.
        const done = record.purpose === "board" ? bb.sdk.threads.delete({ threadId: thread.id, childThreadsConfirmed: true }) : bb.sdk.threads.archive({ threadId: thread.id });
        await done.catch((cause: unknown) => bb.log.warn(`copy: could not put ${thread.id} away: ${error(cause)}`));
        if (again.delete(record.sourceId)) await updateBoard(record.sourceId);
        return;
      }
      if (thread.archivedAt !== null || !isPersonThread(thread.id) || !canCopy(thread.id)) return;
      await updateBoard(thread.id);
    } catch (cause) {
      bb.log.warn(`copy: board update after ${thread.id}'s turn failed: ${error(cause)}`);
    }
  });

  /** Whether a background copy keeps this thread's board, as far as known now: false for a while after bb refused to fork it. */
  function canCopy(sourceId: string): boolean {
    const at = refused.get(sourceId);
    return at === undefined || Date.now() - at > NO_COPY_MS;
  }

  // Refusals survive a reload, so a thread that can't be forked keeps its own board instructions,
  // and so do planned updates, so a reload never drops a thread's last turns from its board.
  void (async () => {
    try {
      for (const key of await bb.storage.kv.list("noCopy:")) {
        const parsed = z.object({ at: z.number() }).safeParse(await bb.storage.kv.get(key));
        if (parsed.success) refused.set(key.slice("noCopy:".length), parsed.data.at);
      }
      for (const key of await bb.storage.kv.list("boardDue:")) {
        const parsed = z.object({ at: z.number() }).safeParse(await bb.storage.kv.get(key));
        const sourceId = key.slice("boardDue:".length);
        if (parsed.success && THREAD_ID.test(sourceId)) await planBoard(sourceId, parsed.data.at);
        else await bb.storage.kv.delete(key);
      }
    } catch (cause) {
      bb.log.warn(`copy: could not read the threads that can't be copied or wait for a board update: ${error(cause)}`);
    }
  })();

  bb.onDispose(() => {
    for (const timer of due.values()) clearTimeout(timer);
    due.clear();
  });

  return {
    run,
    canCopy,
    /** The thread a copy writes for: its source when `threadId` is a copy, else null. */
    async sourceOf(threadId: string): Promise<string | null> {
      return (await recordOf(threadId))?.sourceId ?? null;
    },
    /** The source of a copy whose session or record this plugin has seen; null otherwise. Synchronous, for instructions. */
    knownSourceOf(threadId: string): string | null {
      return known.get(threadId)?.sourceId ?? null;
    },
    /** Learned from a copy's session before its record is stored (the fork's turn can start first). */
    remember(copyId: string, sourceId: string, purpose: CopyPurpose) {
      if (THREAD_ID.test(sourceId) && !known.has(copyId)) known.set(copyId, { sourceId, purpose, at: Date.now() });
    },
  };
}
