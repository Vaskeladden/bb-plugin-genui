// The Status board: a tab in a thread's side panel showing the report its
// agent published with show_board (board-store.ts), rendered as a reply would
// be: prose as markdown, each ```ui and ```app block live. Every version stays
// in the picker, so a board is a point in time the user can go back to.
// BoardOpener, mounted with every visible thread, opens the tab when a version
// the user hasn't seen is published.
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { BOARD_CHANNEL } from "../board-channel";
import { boardSegments, boardSignal, versionNumber, type BoardVersion } from "../core/board";
import { relativeTime } from "../core/project";
import type { rpcContract } from "../server";
import { Fence, useThreadActions } from "./Fence";
import { useMotionScope } from "./components/motion";

/** The `threadPanelAction` id the tab is registered under. */
export const BOARD_ACTION = "board";
export const BOARD_TITLE = "Status board";

/** How often the header's age is refreshed. */
const AGE_TICK_MS = 30_000;
const TIME = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface Board {
  readonly versions: readonly BoardVersion[];
  readonly shown: { readonly id: string; readonly content: string } | null;
}

type Load = { readonly status: "loading" } | { readonly status: "failed"; readonly message: string } | { readonly status: "ready" };

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function BoardTab({ threadId }: PluginThreadPanelProps): ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const motion = useMotionScope();
  const now = useNow();
  /** The version picked from the history; null follows the newest. */
  const [picked, setPicked] = useState<string | null>(null);
  const [published, setPublished] = useState(0);
  const [board, setBoard] = useState<Board | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useRealtime(BOARD_CHANNEL, (payload) => {
    if (boardSignal(payload)?.threadId !== threadId) return;
    // A new version is what the user asked for: show it, whatever was picked.
    setPicked(null);
    setPublished((count) => count + 1);
  });

  useEffect(() => {
    let live = true;
    rpc.call("board_get", { threadId, id: picked }).then(
      (result) => {
        if (!live) return;
        setBoard(result);
        setLoad({ status: "ready" });
      },
      (cause: unknown) => live && setLoad({ status: "failed", message: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, picked, published]);

  const shown = board?.shown ?? null;
  const version = shown === null ? undefined : board?.versions.find((candidate) => candidate.id === shown.id);
  const newest = board?.versions.at(-1);

  let body: ReactNode;
  if (shown !== null && version !== undefined) body = <BoardBody key={shown.id} threadId={threadId} id={shown.id} content={shown.content} />;
  else if (load.status === "loading") body = <Notice>Loading the board…</Notice>;
  else if (load.status === "failed") body = <Notice>Couldn&apos;t read the board: {load.message}</Notice>;
  else body = <Notice>No status board yet. Run Ultrastatus in this thread and its report lands here.</Notice>;

  return (
    <div {...motion} className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
      {version !== undefined && board !== null && newest !== undefined && (
        <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3 @md:flex-row @md:items-center @md:justify-between">
          <div className="min-w-0">
            <h2 className="m-0 line-clamp-2 text-sm font-semibold">{version.title}</h2>
            <p className="m-0 text-xs text-muted-foreground">
              Version {versionNumber(board.versions, version.id)} · {relativeTime(version.at, now)}
              {version.id !== newest.id && <span className="ml-1.5 rounded bg-state-hover px-1.5 py-0.5 font-medium text-foreground">Earlier version</span>}
              {load.status === "failed" && <span className="ml-1.5 text-destructive">Couldn&apos;t refresh: {load.message}</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {version.id !== newest.id && (
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="min-h-10 cursor-pointer rounded-md border border-border px-3 text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Latest
              </button>
            )}
            {board.versions.length > 1 && (
              <select
                aria-label="Version"
                value={version.id}
                onChange={(event) => setPicked(event.target.value === newest.id ? null : event.target.value)}
                className="min-h-10 min-w-0 flex-1 cursor-pointer rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @md:flex-none"
              >
                {[...board.versions].reverse().map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {TIME.format(candidate.at)} · {candidate.title} v{versionNumber(board.versions, candidate.id)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </header>
      )}
      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3")}>{body}</div>
    </div>
  );
}

/** One version, as the reply it would have been. */
function BoardBody({ threadId, id, content }: { threadId: string; id: string; content: string }): ReactElement {
  const actions = useThreadActions();
  const segments = useMemo(() => boardSegments(content), [content]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {segments.map((segment, position) =>
        segment.kind === "markdown" ? (
          <Markdown key={position} content={segment.text} className="min-w-0 text-sm" />
        ) : (
          <div key={position} data-genui-fence="" data-genui-renderer="board">
            <Fence
              language={segment.language}
              code={segment.code}
              complete
              stateKey={`bb.genui.state:board:${id}#${segment.language}#${segment.index}`}
              threadId={threadId}
              // No message holds a board's blocks: an id BB's outline never lists keeps them from counting as answered.
              messageId={`board:${id}`}
              fence={segment.index}
              actions={actions}
            />
          </div>
        ),
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }): ReactElement {
  return <p className="m-0 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

const seenKey = (threadId: string): string => `bb.genui.board.seen:${threadId}`;

function lastSeen(threadId: string): string | null {
  try {
    return window.localStorage.getItem(seenKey(threadId));
  } catch {
    return null;
  }
}

function markSeen(threadId: string, id: string): void {
  try {
    window.localStorage.setItem(seenKey(threadId), id);
  } catch {
    // Without storage the tab opens again on the next visit, which is harmless.
  }
}

/**
 * Opens the thread's Status board tab for a version this browser hasn't
 * opened it for: one published while the thread is on screen, or found when
 * the thread is opened. Renders nothing.
 */
export function BoardOpener({ threadId }: PluginThreadHeaderActionProps): null {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const open = useCallback(
    (id: string) => {
      if (lastSeen(threadId) === id) return;
      if (navigate.openThreadPanel({ actionId: BOARD_ACTION })) markSeen(threadId, id);
    },
    [navigate, threadId],
  );

  useRealtime(BOARD_CHANNEL, (payload) => {
    const signal = boardSignal(payload);
    if (signal?.threadId === threadId) open(signal.id);
  });

  useEffect(() => {
    let live = true;
    rpc.call("board_get", { threadId, id: null }).then(
      ({ versions }) => {
        const newest = versions.at(-1);
        if (live && newest !== undefined) open(newest.id);
      },
      // The tab itself reports a board that can't be read.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, open]);

  return null;
}
