// Where a thread's status boards are kept (core/board.ts has the rules): the
// version list under `board:<thread>`, each version's text under
// `board:<thread>:<version>`, so a full history stays under the store's
// 256 KB per value. Publishing tells every open page over the `board`
// realtime channel, which opens the thread's Status board tab.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BOARD_CHANNEL } from "./board-channel";
import { withVersion, type BoardKind, type BoardMode, type BoardVersion } from "./core/board";

const versionSchema = z.object({
  id: z.string(),
  board: z.string(),
  title: z.string(),
  at: z.number(),
  chat: z.number().nullable().optional(),
  kind: z.enum(["ultrastatus", "update"]).optional(),
});
const versionsSchema = z.array(versionSchema);
const contentSchema = z.object({ content: z.string() });

export interface BoardStore {
  /** The thread's versions, oldest first; empty when it has no board. */
  versions(threadId: string): Promise<BoardVersion[]>;
  /** Every thread that has a board. */
  threads(): Promise<string[]>;
  /** A version's text; null when the thread has no such version. */
  content(threadId: string, id: string): Promise<string | null>;
  /** Stores a version, drops the ones that fell out of the history, and announces it. `chat` is the chat message it comes after. */
  publish(
    threadId: string,
    published: { content: string; title: string | null; mode: BoardMode; kind: BoardKind; chat: number | null },
  ): Promise<{ added: BoardVersion; versions: BoardVersion[] }>;
}

export function createBoardStore(bb: Pick<BbPluginApi, "storage" | "realtime">, now: () => number = Date.now): BoardStore {
  const listKey = (threadId: string): string => `board:${threadId}`;
  const contentKey = (threadId: string, id: string): string => `board:${threadId}:${id}`;

  const versions = async (threadId: string): Promise<BoardVersion[]> => {
    const parsed = versionsSchema.safeParse(await bb.storage.kv.get(listKey(threadId)));
    return parsed.success ? parsed.data : [];
  };

  return {
    versions,
    async threads() {
      // A version's text is under `board:<thread>:<version>`; the list key alone names a thread with a board.
      const keys = await bb.storage.kv.list("board:");
      return keys.map((key) => key.slice("board:".length)).filter((rest) => rest !== "" && !rest.includes(":"));
    },
    async content(threadId, id) {
      const parsed = contentSchema.safeParse(await bb.storage.kv.get(contentKey(threadId, id)));
      return parsed.success ? parsed.data.content : null;
    },
    async publish(threadId, { content, title, mode, kind, chat }) {
      const next = withVersion(await versions(threadId), { id: randomUUID().slice(0, 8), title, mode, kind, at: now(), chat });
      // The text first: a version in the list always has its text.
      await bb.storage.kv.set(contentKey(threadId, next.added.id), { content });
      await bb.storage.kv.set(listKey(threadId), next.versions);
      await Promise.all(next.dropped.map((id) => bb.storage.kv.delete(contentKey(threadId, id))));
      bb.realtime.publish(BOARD_CHANNEL, { threadId, id: next.added.id, kind });
      return { added: next.added, versions: next.versions };
    },
  };
}
