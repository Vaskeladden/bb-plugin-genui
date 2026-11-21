// The Status board: a tab in a thread's side panel showing the report its
// agent published with show_board (board-store.ts), rendered as a reply would
// be: prose as markdown, each ```ui and ```app block live. Every version stays
// in the picker, so a board is a point in time the user can go back to.
// BoardOpener, mounted with every visible thread (a thread header row that
// takes no space), opens the tab when a version the user hasn't seen is
// published.
//
// The board is where the user goes on with the work, not only where they read
// it: Update and New board ask the agent for a fresh report, and what the user
// picks in the board's blocks (a step, a decision, a form) is staged in the
// thread's message field as in a reply; the bar at the bottom sends it without
// leaving the side panel.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import {
  experimental_useAppPanel,
  Markdown,
  useComposers,
  useRealtime,
  useRpc,
  type ExperimentalTabReference,
  type ExperimentalThreadActionTabProps,
  type ExperimentalThreadHeaderRowProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { BOARD_CHANNEL } from "../board-channel";
import { boardOrigin, boardSegments, boardSignal, versionNumber, type BoardMode, type BoardVersion } from "../core/board";
import { relativeTime } from "../core/project";
import type { rpcContract } from "../server";
import { Fence, useThreadActions } from "./Fence";
import { flushAnswers, sheetFor } from "./answerSheet";
import { useMotionScope } from "./components/motion";

/**
 * The tab as registered and as opened: an action tab of a thread's side panel.
 * The id is the one the tab had under bb's earlier panel-action slot, so tabs bb saved keep theirs.
 */
export const BOARD_TAB = { id: "board", context: { kind: "thread" }, availability: "action" } as const satisfies ExperimentalTabReference;
export const BOARD_TITLE = "Status board";

/** How often the header's age is refreshed. */
const AGE_TICK_MS = 30_000;
const TIME = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface Board {
  readonly versions: readonly BoardVersion[];
  readonly shown: { readonly id: string; readonly content: string } | null;
}

type Load = { readonly status: "loading" } | { readonly status: "failed"; readonly message: string } | { readonly status: "ready" };

/** A request for a fresh report, from the board's own buttons, until the report it asked for is published. */
type Asked =
  | { readonly status: "idle" }
  | { readonly status: "asking"; readonly mode: BoardMode }
  | { readonly status: "asked"; readonly mode: BoardMode }
  | { readonly status: "failed"; readonly message: string };

const BUTTON =
  "min-h-10 cursor-pointer rounded-md border border-border px-3 text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
const PRIMARY_BUTTON =
  "min-h-10 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function BoardTab({ threadId }: ExperimentalThreadActionTabProps): ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const motion = useMotionScope();
  const now = useNow();
  /** The version picked from the history; null follows the newest. */
  const [picked, setPicked] = useState<string | null>(null);
  const [published, setPublished] = useState(0);
  const [board, setBoard] = useState<Board | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [asked, setAsked] = useState<Asked>({ status: "idle" });

  useRealtime(BOARD_CHANNEL, (payload) => {
    if (boardSignal(payload)?.threadId !== threadId) return;
    // A new version is what the user asked for: show it, whatever was picked.
    setPicked(null);
    setPublished((count) => count + 1);
    setAsked({ status: "idle" });
  });

  const request = useCallback(
    (mode: BoardMode) => {
      setAsked({ status: "asking", mode });
      rpc.call("board_request", { threadId, mode }).then(
        (result) => setAsked(result.ok ? { status: "asked", mode } : { status: "failed", message: result.message }),
        (cause: unknown) => setAsked({ status: "failed", message: messageOf(cause) }),
      );
    },
    [rpc, threadId],
  );

  useEffect(() => {
    let live = true;
    rpc.call("board_get", { threadId, id: picked }).then(
      (result) => {
        if (!live) return;
        setBoard(result);
        setLoad({ status: "ready" });
      },
      (cause: unknown) => live && setLoad({ status: "failed", message: messageOf(cause) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, picked, published]);

  const shown = board?.shown ?? null;
  const version = shown === null ? undefined : board?.versions.find((candidate) => candidate.id === shown.id);
  const newest = board?.versions.at(-1);

  let body: ReactNode;
  if (shown !== null && version !== undefined && board !== null) {
    const origin = boardOrigin(threadId, board.versions, shown.id, TIME.format(version.at)) ?? undefined;
    body = <BoardBody key={shown.id} threadId={threadId} id={shown.id} content={shown.content} origin={origin} />;
  }
  else if (load.status === "loading") body = <Notice>Loading the board…</Notice>;
  else if (load.status === "failed") body = <Notice>Couldn&apos;t read the board: {load.message}</Notice>;
  else
    body = (
      <div className="flex flex-col items-start gap-3">
        <Notice>No status board yet. Run Ultrastatus in this thread and its report lands here.</Notice>
        <button type="button" disabled={asked.status === "asking"} onClick={() => request("new")} className={PRIMARY_BUTTON}>
          Run Ultrastatus
        </button>
        <RequestNote asked={asked} />
      </div>
    );

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
            <RequestNote asked={asked} />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={asked.status === "asking"}
              onClick={() => request("update")}
              title="Ask the agent for a fresh Ultrastatus as the next version of this board"
              className={PRIMARY_BUTTON}
            >
              Update
            </button>
            <button
              type="button"
              disabled={asked.status === "asking"}
              onClick={() => request("new")}
              title="Ask the agent for a fresh Ultrastatus as a new board; this one stays in the history"
              className={BUTTON}
            >
              New board
            </button>
            {version.id !== newest.id && (
              <button type="button" onClick={() => setPicked(null)} className={BUTTON}>
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
      <BoardAnswers threadId={threadId} />
    </div>
  );
}

/** What became of the last Update or New board press; nothing before the first. */
function RequestNote({ asked }: { asked: Asked }): ReactElement | null {
  if (asked.status === "idle") return null;
  if (asked.status === "failed") {
    return (
      <p role="alert" className="m-0 mt-1 text-xs text-destructive">
        Couldn&apos;t ask for a report: {asked.message}
      </p>
    );
  }
  const what = asked.mode === "new" ? "a new board" : "an update";
  return (
    <p role="status" className="m-0 mt-1 text-xs text-muted-foreground">
      {asked.status === "asking" ? `Asking for ${what}…` : `Asked the agent for ${what}. It shows here when the report is ready.`}
    </p>
  );
}

/**
 * The answers the user picked on the board (and in the thread's replies) that
 * stand in the message field, with a button that sends the field as it is, so
 * a decision made in the side panel is sent from the side panel. Nothing when
 * no answer waits, or when the thread's message field isn't on screen (then
 * each pick was sent at once).
 */
function BoardAnswers({ threadId }: { threadId: string }): ReactElement | null {
  const composer = useComposers().find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === threadId) ?? null;
  const sheet = sheetFor(threadId);
  const waiting = useSyncExternalStore(sheet.subscribe, sheet.waiting);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (composer === null || waiting === 0) return null;
  // BB before `submit` on a composer: the answers are still in the field, sent from there.
  const canSend = typeof composer.submit === "function";
  const send = (): void => {
    // A Form field still waiting out its typing pause is written first.
    flushAnswers();
    setSending(true);
    setFailure(null);
    composer.submit({ experimental_data: { source: "genui.board" } }).then(
      () => setSending(false),
      (cause: unknown) => {
        setSending(false);
        setFailure(messageOf(cause));
      },
    );
  };
  return (
    <footer className="flex shrink-0 flex-col gap-2 border-t border-border bg-background px-4 py-2 @md:flex-row @md:items-center @md:justify-between">
      <p className="m-0 min-w-0 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {waiting} {waiting === 1 ? "answer" : "answers"} ready
        </span>{" "}
        in the message field{canSend ? "." : ": send it from there."}
        {failure !== null && (
          <span role="alert" className="ml-1.5 text-destructive">
            Not sent: {failure}
          </span>
        )}
      </p>
      {canSend && (
        <button type="button" disabled={sending} onClick={send} title="Sends the message field as it is, with anything you typed there" className={cn(PRIMARY_BUTTON, "min-h-11 shrink-0")}>
          {sending ? "Sending…" : "Send to chat"}
        </button>
      )}
    </footer>
  );
}

/**
 * One version, as the reply it would have been. `origin` goes above what the
 * user answers here, so the agent knows which version the answer was given on.
 */
function BoardBody({ threadId, id, content, origin }: { threadId: string; id: string; content: string; origin: string | undefined }): ReactElement {
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
              origin={origin}
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
export function BoardOpener({ threadId }: ExperimentalThreadHeaderRowProps): null {
  const rpc = useRpc<typeof rpcContract>();
  // The side panel of the thread this row is mounted in.
  const panel = experimental_useAppPanel();
  const open = useCallback(
    (id: string) => {
      if (lastSeen(threadId) === id) return;
      if (panel.openTab({ tab: BOARD_TAB })) markSeen(threadId, id);
    },
    [panel, threadId],
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
