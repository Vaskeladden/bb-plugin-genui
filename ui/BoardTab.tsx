// The Status board: a tab in a thread's side panel showing the report its
// agent published with show_board (board-store.ts), rendered as a reply would
// be: prose as markdown, each ```ui and ```app block live. Every version stays
// in the picker, so a board is a point in time the user can go back to.
// The tab is always there (a fixed tab): every thread has a board, which its
// agent makes in its first turn and keeps current (instructions.ts). A thread
// from before that gets its first board when the tab is first shown
// (board_start). BoardOpener, mounted with every visible thread (a thread
// header row that takes no space), makes the board the view a thread opens
// on, and opens it again when an Ultrastatus lands.
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
  type ExperimentalThreadHeaderRowProps,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BOARD_CHANNEL, BOARD_COPY_CHANNEL } from "../board-channel";
import { boardOrigin, boardSegments, boardSignal, kindOf, lastUltrastatus, versionNumber, type BoardMode, type BoardVersion } from "../core/board";
import { relativeTime } from "../core/project";
import type { rpcContract } from "../server";
import { Fence, useThreadActions } from "./Fence";
import { flushAnswers, sheetFor } from "./answerSheet";
import { useMotionScope } from "./components/motion";

/**
 * The tab as registered and as opened: a fixed tab of every thread's side
 * panel, since every thread has a board.
 */
export const BOARD_TAB = { id: "board", context: { kind: "thread" }, availability: "fixed" } as const satisfies ExperimentalTabReference;
export const BOARD_TITLE = "Status board";

/** How often the header's age is refreshed. */
const AGE_TICK_MS = 30_000;
const TIME = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface Board {
  readonly versions: readonly BoardVersion[];
  readonly shown: { readonly id: string; readonly content: string } | null;
  /** The background copy working on the board now, if any. */
  readonly copy: Copy | null;
}

interface Copy {
  readonly purpose: "board" | "status" | "ultra";
  readonly since: number;
}

type Load = { readonly status: "loading" } | { readonly status: "failed"; readonly message: string } | { readonly status: "ready" };

/** A request for a fresh report, from the board's own buttons, until the report it asked for is published. */
type Asked =
  | { readonly status: "idle" }
  | { readonly status: "asking"; readonly mode: BoardMode }
  | { readonly status: "asked"; readonly mode: BoardMode }
  | { readonly status: "failed"; readonly message: string };

/** What became of asking the agent for a thread's first board. */
type Started =
  | { readonly status: "idle" }
  | { readonly status: "asking" }
  | { readonly status: "done"; readonly result: "asked" | "has-board" | "already-asked" | "busy" | "no-history" | "archived" }
  | { readonly status: "failed"; readonly message: string };

const BUTTON =
  "min-h-10 cursor-pointer rounded-md border border-border px-3 text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
/** The header's buttons: small, so the header stays one thin row. */
const SMALL_BUTTON =
  "inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
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

export function BoardTab({ threadId }: ExperimentalThreadTabProps): ReactElement {
  const rpc = useRpc<typeof rpcContract>();
  const motion = useMotionScope();
  const now = useNow();
  /** The version picked from the history; null follows the newest. */
  const [picked, setPicked] = useState<string | null>(null);
  const [published, setPublished] = useState(0);
  const [board, setBoard] = useState<Board | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [asked, setAsked] = useState<Asked>({ status: "idle" });
  const [started, setStarted] = useState<Started>({ status: "idle" });
  /** Bumped when a background copy for this thread starts or ends, so its loader follows it. */
  const [copyTick, setCopyTick] = useState(0);

  useRealtime(BOARD_CHANNEL, (payload) => {
    if (boardSignal(payload)?.threadId !== threadId) return;
    // A new version is what the user asked for: show it, whatever was picked.
    setPicked(null);
    setPublished((count) => count + 1);
    setAsked({ status: "idle" });
  });
  useRealtime(BOARD_COPY_CHANNEL, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId !== threadId) return;
    setCopyTick((count) => count + 1);
    // The copy's loader takes over from «Asked…»; when it ends without a new version, the note would wait forever.
    setAsked((current) => (current.status === "asked" ? { status: "idle" } : current));
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

  const start = useCallback(
    (force: boolean) => {
      setStarted({ status: "asking" });
      rpc.call("board_start", { threadId, force }).then(
        (result) => setStarted(result.status === "failed" ? { status: "failed", message: result.message ?? "unknown error" } : { status: "done", result: result.status }),
        (cause: unknown) => setStarted({ status: "failed", message: messageOf(cause) }),
      );
    },
    [rpc, threadId],
  );

  const empty = load.status === "ready" && board !== null && board.versions.length === 0;
  // A thread from before every thread had a board: ask its agent for one, once (the server remembers).
  useEffect(() => {
    if (empty) start(false);
  }, [empty, start]);

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
  }, [rpc, threadId, picked, published, copyTick]);

  const shown = board?.shown ?? null;
  const version = shown === null ? undefined : board?.versions.find((candidate) => candidate.id === shown.id);
  const newest = board?.versions.at(-1);
  const copy = board?.copy ?? null;
  /** A Status or Ultrastatus already runs: asking again would only start a second one. */
  const reporting = copy !== null && copy.purpose !== "board";

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
        <Notice>No status board yet. The agent makes one in its next turn, from what it knows of this thread.</Notice>
        <StartNote started={started} />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={started.status === "asking"} onClick={() => start(true)} className={PRIMARY_BUTTON}>
            Make it now
          </button>
          <button
            type="button"
            disabled={asked.status === "asking" || reporting}
            onClick={() => request("new")}
            title="Ask the agent to check every part of the work again and make the board from that"
            className={BUTTON}
          >
            Run Ultrastatus
          </button>
        </div>
        {copy !== null ? <CopyNote copy={copy} now={now} /> : <RequestNote asked={asked} />}
      </div>
    );

  return (
    <div {...motion} className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
      {version !== undefined && board !== null && newest !== undefined && (
        <header className="shrink-0 border-b border-border px-3 py-1.5">
          {/* One thin row: title, version and age, then small buttons; it wraps on a narrow panel. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="m-0 flex min-w-0 flex-1 basis-48 items-baseline gap-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={version.title}>
                {version.title}
              </span>
              <span className="shrink-0 whitespace-nowrap">
                v{versionNumber(board.versions, version.id)} · {relativeTime(version.at, now)}
              </span>
            </p>
            <div className="flex min-w-0 items-center gap-1">
              {version.id !== newest.id && (
                <button type="button" onClick={() => setPicked(null)} className={SMALL_BUTTON}>
                  Latest
                </button>
              )}
              {board.versions.length > 1 && (
                <select
                  aria-label="Version"
                  value={version.id}
                  onChange={(event) => setPicked(event.target.value === newest.id ? null : event.target.value)}
                  className="h-8 w-24 min-w-0 cursor-pointer truncate rounded-md border border-border bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @md:w-40"
                >
                  {[...board.versions].reverse().map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      v{versionNumber(board.versions, candidate.id)} · {TIME.format(candidate.at)} · {candidate.title}
                      {kindOf(candidate) === "ultrastatus" ? " · Ultrastatus" : ""}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={asked.status === "asking" || reporting}
                onClick={() => request("update")}
                title="Ultrastatus: the agent checks every part of the work again and brings this board in line with what is really done"
                className={SMALL_BUTTON}
              >
                <Icon name="RefreshCw" className="size-3.5" />
                Ultrastatus
              </button>
              <button
                type="button"
                disabled={asked.status === "asking" || reporting}
                onClick={() => request("new")}
                title="New board: a fresh Ultrastatus that starts the board over; this one stays in the history"
                aria-label="New board"
                className={SMALL_BUTTON}
              >
                <Icon name="Plus" className="size-3.5" />
                <span className="hidden @md:inline">New board</span>
              </button>
            </div>
          </div>
          <p className="m-0 text-[11px] leading-4 text-muted-foreground">
            <KindNote versions={board.versions} version={version} now={now} />
            {version.id !== newest.id && <span className="ml-1.5 rounded bg-state-hover px-1 font-medium text-foreground">Earlier version</span>}
            {load.status === "failed" && <span className="ml-1.5 text-destructive">Couldn&apos;t refresh: {load.message}</span>}
          </p>
          {copy !== null ? <CopyNote copy={copy} now={now} /> : <RequestNote asked={asked} />}
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

const COPY_WORK: Record<Copy["purpose"], string> = {
  board: "Checking whether the board needs an update",
  status: "Status is running",
  ultra: "Ultrastatus is running",
};

/** The loader while a background copy works on this board: what it does and since when. */
function CopyNote({ copy, now }: { copy: Copy; now: number }): ReactElement {
  return (
    <p role="status" className="m-0 mt-1 flex items-center gap-1.5 text-xs text-foreground">
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0 text-primary">
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="origin-center animate-spin motion-reduce:animate-none" />
      </svg>
      <span>
        {COPY_WORK[copy.purpose]} in the background · started {relativeTime(copy.since, now)}.
        {copy.purpose === "board" ? " It changes only if something moved." : " The board changes here when it is done."}
      </span>
    </p>
  );
}

/** What became of asking for the thread's first board; nothing until it was asked. */
function StartNote({ started }: { started: Started }): ReactElement | null {
  if (started.status === "idle") return null;
  if (started.status === "failed") {
    return (
      <p role="alert" className="m-0 text-xs text-destructive">
        Couldn&apos;t ask for a board: {started.message}
      </p>
    );
  }
  const text =
    started.status === "asking"
      ? "Asking the agent for a board…"
      : {
          asked: "Asked the agent for a board. It shows here when it is ready.",
          "has-board": "The board is there; loading it…",
          "already-asked": "The agent was already asked for a board. Press Make it now to ask again.",
          busy: "The agent is working now and makes the board before its turn ends.",
          "no-history": "Nothing has happened in this thread yet. The board comes with the first message.",
          archived: "This thread is archived, so no board was asked for.",
        }[started.result];
  return (
    <p role="status" className="m-0 text-xs text-muted-foreground">
      {text}
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
 * What a version is worth: an Ultrastatus checked every row again; an update
 * is the agent's own account of its work and never counts as one, so it says
 * when the board was last checked.
 */
function KindNote({ versions, version, now }: { versions: readonly BoardVersion[]; version: BoardVersion; now: number }): ReactElement {
  if (kindOf(version) === "ultrastatus") {
    return <span className="rounded bg-state-hover px-1 font-medium text-foreground">Ultrastatus: every part checked</span>;
  }
  const checked = lastUltrastatus(versions, version);
  return (
    <span title="The agent updated the board from its own work, without checking every row again. Only an Ultrastatus checks them all.">
      Update, not checked again · {checked === null ? "no Ultrastatus in the history" : `last Ultrastatus ${relativeTime(checked.at, now)}`}
    </span>
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

/** Threads whose board this page load already opened on: the board is the view a thread opens on, once. */
const openedOnArrival = new Set<string>();

/**
 * Makes the Status board the view a thread opens on (once per thread per page
 * load, so a user who moves to another tab keeps it), and opens it again when
 * an Ultrastatus this browser hasn't shown lands. The agent's own updates,
 * published every turn, don't pull the user away from another tab. Renders
 * nothing.
 */
export function BoardOpener({ threadId }: ExperimentalThreadHeaderRowProps): null {
  // The side panel of the thread this row is mounted in.
  const panel = experimental_useAppPanel();

  useRealtime(BOARD_CHANNEL, (payload) => {
    const signal = boardSignal(payload);
    if (signal?.threadId !== threadId || signal.kind !== "ultrastatus" || lastSeen(threadId) === signal.id) return;
    if (panel.openTab({ tab: BOARD_TAB })) markSeen(threadId, signal.id);
  });

  useEffect(() => {
    if (openedOnArrival.has(threadId)) return;
    if (panel.openTab({ tab: BOARD_TAB })) openedOnArrival.add(threadId);
  }, [panel, threadId]);

  return null;
}
