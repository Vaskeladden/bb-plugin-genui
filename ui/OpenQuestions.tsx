// "Your next move": the newest question a thread's agent asked that the user
// has not answered, kept above the message field. A reply's Form, Buttons,
// Plan or Decision shows here as the same block: one identity (message,
// fence, state key) with the copy in the reply, so a pick made here is staged
// in the same answers block. While the box shows a block, the reply's copy
// folds to a line pointing here (ui/nextMove.ts), so it is answered in one
// place, wherever the reply has scrolled to. A CI result, a run result or
// another thread's message after the question leaves it open here.
//
// While the agent's turn runs, only questions from earlier turns show: the
// running turn's text is still being written. A Status or Ultrastatus report
// a background copy wrote (copies.ts) asks here too, until the thread's own
// agent replies; its answer says which report it answers.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { useComposer, useRealtime, useRpc, useSdk, type PluginBrowserBbSdk as Sdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { compile } from "../core";
import { boardSegments } from "../core/board";
import { asksQuestion } from "../core/questions";
import { BOARD_COPY_CHANNEL } from "../board-channel";
import type { CopyReport } from "../copies";
import type { rpcContract } from "../server";
import { Fence, useThreadActions } from "./Fence";
import { nextMoveKey, showInNextMove } from "./nextMove";
import { openFromNothing } from "./components/motion";
import type { OpenReplies } from "./supersession";
import { useOpenReplies } from "./useSuperseded";

/** One ```ui block of a reply that asks the user something. */
export interface QuestionBlock {
  readonly messageId: string;
  /** The block's index among the message's ```ui blocks, as BB counts them. */
  readonly index: number;
  readonly code: string;
  /** For a block not in the thread (a background copy's report): the line put above its answers. */
  readonly origin?: string;
}

/** The ```ui blocks of a reply's text that ask something; a block that does not compile asks nothing. */
export function questionBlocks(messageId: string, text: string): QuestionBlock[] {
  return boardSegments(text).flatMap((segment) => {
    if (segment.kind !== "block" || segment.language !== "ui") return [];
    const { program } = compile(segment.code);
    return program !== null && asksQuestion(program) ? [{ messageId, index: segment.index, code: segment.code }] : [];
  });
}

/** The message id a copy's report stands under: not a row of the thread, so its answers are keyed apart. */
const copyMessageId = (copyId: string): string => `copy:${copyId}`;

/** The line above answers to a copy's report: the thread's own agent never saw that report. */
export function copyOrigin(report: Pick<CopyReport, "copyId" | "at">): string {
  const at = new Date(report.at).toISOString().slice(11, 16);
  return `Answering the status report a background copy of you wrote at ${at} UTC, which is not in your history. Read it first: \`bb thread output ${report.copyId}\``;
}

/** The questions of the report a background copy wrote for this thread, read again whenever a copy starts or ends. */
function useCopyQuestions(threadId: string, running: boolean): readonly QuestionBlock[] {
  const rpc = useRpc<typeof rpcContract>();
  const [tick, setTick] = useState(0);
  const [blocks, setBlocks] = useState<{ threadId: string; blocks: readonly QuestionBlock[] }>({ threadId, blocks: NO_BLOCKS });
  useRealtime(BOARD_COPY_CHANNEL, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) setTick((count) => count + 1);
  });
  useEffect(() => {
    let live = true;
    rpc.call("copy_report", { threadId }).then(
      (report) => {
        if (!live) return;
        const found = report === null ? NO_BLOCKS : questionBlocks(copyMessageId(report.copyId), report.text).map((block) => ({ ...block, origin: copyOrigin(report) }));
        setBlocks({ threadId, blocks: found });
      },
      // A failed read keeps what is shown.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, running, tick]);
  return blocks.threadId === threadId ? blocks.blocks : NO_BLOCKS;
}

/** The most turns one timeline page is asked for. */
const MAX_TURNS = 24;
/**
 * Pages read for one set of replies: BB's newest page holds the running turn
 * only, whatever is asked for, and the pages before it the turns asked for.
 * A reply older than these stays in the chat only.
 */
const MAX_PAGES = 4;
/** A finished reply's text does not change: its question blocks are read once per page. */
const MAX_REMEMBERED = 500;
const RETRY_DELAY_MS = 4_000;
const MAX_ATTEMPTS = 3;
const remembered = new Map<string, readonly QuestionBlock[]>();
const NO_BLOCKS: readonly QuestionBlock[] = [];

function remember(messageId: string, blocks: readonly QuestionBlock[]): void {
  remembered.set(messageId, blocks);
  while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
}

/** A page of BB's timeline, read without a change tag. */
type Timeline = Awaited<ReturnType<Sdk["threads"]["timeline"]>>;

/** The text of the replies in `wanted` (taken out of it as they are found), from the thread's newest timeline pages. */
async function replyTexts(sdk: Sdk, threadId: string, wanted: Set<string>, turns: number, signal: AbortSignal): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  let before: { beforeAnchorId: string; beforeAnchorSeq: string } | undefined;
  for (let page = 0; page < MAX_PAGES && wanted.size > 0; page++) {
    const read: Timeline = await sdk.threads.timeline({ threadId, segmentLimit: String(turns), deferContent: "true", signal, ...before });
    for (const row of read.rows) {
      if (row.kind === "conversation" && row.role === "assistant" && wanted.delete(row.id)) texts.set(row.id, row.text);
    }
    const older = read.timelinePage?.olderCursor;
    if (older == null) break;
    before = { beforeAnchorId: older.anchorId, beforeAnchorSeq: String(older.anchorSeq) };
  }
  return texts;
}

/**
 * The question blocks of the newest reply in `replies` that asks something.
 * Reads the thread's timeline when a reply's text is not known yet; a failed read is
 * tried again a few times, and until one works the replies it would have
 * covered show nothing.
 */
function useQuestionBlocks(threadId: string, replies: OpenReplies): readonly QuestionBlock[] {
  const sdk = useSdk();
  const [, setRead] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const missing = replies.ids.filter((id) => !remembered.has(id)).join("\n");
  const turns = Math.min(replies.turns, MAX_TURNS);
  useEffect(() => setAttempt(0), [missing]);
  useEffect(() => {
    if (missing === "" || attempt >= MAX_ATTEMPTS) return;
    const wanted = new Set(missing.split("\n"));
    const abort = new AbortController();
    let retry: number | undefined;
    replyTexts(sdk, threadId, wanted, turns, abort.signal).then(
      (texts) => {
        for (const [id, text] of texts) remember(id, questionBlocks(id, text));
        for (const id of wanted) remember(id, []);
        setRead((count) => count + 1);
      },
      () => {
        if (!abort.signal.aborted) retry = window.setTimeout(() => setAttempt((count) => count + 1), RETRY_DELAY_MS);
      },
    );
    return () => {
      abort.abort();
      window.clearTimeout(retry);
    };
  }, [sdk, threadId, missing, turns, attempt]);
  // The newest reply that asks stands for the ones before it: an agent that
  // was not answered asks again, and a thread other threads drive would
  // otherwise stack every question it ever put to them.
  for (let index = replies.ids.length - 1; index >= 0; index--) {
    const blocks = remembered.get(replies.ids[index]!);
    if (blocks !== undefined && blocks.length > 0) return blocks;
  }
  return NO_BLOCKS;
}

const foldedKey = (threadId: string): string => `bb.genui.questions.folded:${threadId}`;

function readFolded(threadId: string): boolean {
  try {
    return window.localStorage.getItem(foldedKey(threadId)) === "1";
  } catch {
    return false;
  }
}

/**
 * Keeps the first question of the blocks in view inside the banner's scroll
 * area: a block is the reply's whole card, and what it asks is often below
 * the figures it shows first. Follows the blocks as they take their size
 * (pictures, loaded data), until the user scrolls or touches them.
 */
function useQuestionInView(blocks: readonly QuestionBlock[], folded: boolean): RefObject<HTMLDivElement | null> {
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    let touched = false;
    const touch = (): void => {
      touched = true;
    };
    const place = (): void => {
      if (touched) return;
      const question = node.querySelector("[data-genui-question]");
      if (question === null) return;
      const area = node.getBoundingClientRect();
      const asked = question.getBoundingClientRect();
      // Its end comes into view, but never so far that its start leaves.
      const down = Math.min(asked.bottom - area.bottom + 8, asked.top - area.top);
      if (down > 0) node.scrollTop += down;
    };
    const observer = new ResizeObserver(place);
    for (const child of node.children) observer.observe(child);
    const intents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const intent of intents) node.addEventListener(intent, touch, { passive: true });
    place();
    return () => {
      observer.disconnect();
      for (const intent of intents) node.removeEventListener(intent, touch);
    };
  }, [blocks, folded]);
  return scroller;
}

/**
 * Opens the box smoothly when a question arrives while the message field is
 * on screen (a turn ended), as the reply's copy glides shut. A box that is
 * already there when the thread opens holds still.
 */
const OPEN_SETTLE_MS = 1500;

function useOpensSmoothly(open: boolean): RefObject<HTMLElement | null> {
  const box = useRef<HTMLElement | null>(null);
  const wasClosed = useRef(false);
  const mountedAt = useRef(performance.now());
  useLayoutEffect(() => {
    if (!open) {
      wasClosed.current = true;
      return;
    }
    // The thread's first load also arrives a moment after the box mounts: that holds still.
    const settled = performance.now() - mountedAt.current > OPEN_SETTLE_MS;
    if (!wasClosed.current || !settled || box.current === null) return;
    wasClosed.current = false;
    const animation = openFromNothing(box.current);
    return () => animation?.cancel();
  }, [open]);
  return box;
}

function OpenQuestions({ threadId, running }: { threadId: string; running: boolean }): ReactElement | null {
  const replyBlocks = useQuestionBlocks(threadId, useOpenReplies(threadId, running));
  // A copy's report came after the thread's last reply (its own agent's next reply drops it): it asks now.
  const copyBlocks = useCopyQuestions(threadId, running);
  const blocks = copyBlocks.length > 0 ? copyBlocks : replyBlocks;
  const actions = useThreadActions();
  const [folded, setFolded] = useState(() => readFolded(threadId));
  useEffect(() => setFolded(readFolded(threadId)), [threadId]);
  const scroller = useQuestionInView(blocks, folded);
  // Folded, the box shows no block: the reply keeps its own copy open.
  const keys = folded ? "" : blocks.map((block) => nextMoveKey(block.messageId, block.index)).join("\n");
  useEffect(() => (keys === "" ? undefined : showInNextMove(keys.split("\n"))), [keys]);
  const box = useOpensSmoothly(blocks.length > 0);
  if (blocks.length === 0) return null;
  const toggle = (): void => {
    const next = !folded;
    setFolded(next);
    try {
      if (next) window.localStorage.setItem(foldedKey(threadId), "1");
      else window.localStorage.removeItem(foldedKey(threadId));
    } catch {
      // Without storage the choice lasts for this page.
    }
  };
  return (
    <section ref={box} aria-label="Your next move" data-genui-open-questions="" className="mb-1 flex min-w-0 flex-col rounded-lg border border-border bg-background">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={toggle}
        className="flex min-h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 text-left text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="MessageCircle" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Your next move</span>
        <span className="min-w-0 flex-1 truncate text-right font-normal text-muted-foreground">
          {folded ? (blocks.length === 1 ? "1 question waits" : `${blocks.length} questions wait`) : "Pick, then send"}
        </span>
        <Icon name={folded ? "ChevronRight" : "ChevronDown"} aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {folded ? null : (
        <div ref={scroller} className="flex max-h-[40dvh] min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {blocks.map((block) => (
            <div key={`${block.messageId}#${block.index}`} data-genui-fence="" data-genui-renderer="composer">
              <Fence
                language="ui"
                code={block.code}
                complete
                stateKey={`bb.genui.state:${block.messageId}#ui#${block.index}`}
                threadId={threadId}
                messageId={block.messageId}
                fence={block.index}
                actions={actions}
                origin={block.origin}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The composer banner: a thread's message field only, since a new thread has no replies. */
export function OpenQuestionsBanner(): ReactElement | null {
  const composer = useComposer();
  return composer.scope.kind === "thread" ? <OpenQuestions threadId={composer.scope.threadId} running={composer.isRunning === true} /> : null;
}
