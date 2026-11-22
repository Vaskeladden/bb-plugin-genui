// The newest question a thread's agent asked that the user has not answered,
// kept above the message field. A reply's Form, Buttons, Plan or Decision stays
// answerable where it stands, but a CI result, a run result or another
// thread's message pushes it up the thread, where it is easy to miss. This
// banner shows those blocks again, as the same blocks: one identity (message,
// fence, state key) with the copy in the reply, so a pick made here is staged
// in the same answers block and both copies close when the user sends.
//
// Nothing is shown while the unanswered reply is the thread's newest turn:
// it stands right above the message field already.
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { useComposer, useSdk, type PluginBrowserBbSdk as Sdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { compile } from "../core";
import { boardSegments } from "../core/board";
import { asksQuestion } from "../core/questions";
import { Fence, useThreadActions } from "./Fence";
import type { OpenReplies } from "./supersession";
import { useOpenReplies } from "./useSuperseded";

/** One ```ui block of a reply that asks the user something. */
export interface QuestionBlock {
  readonly messageId: string;
  /** The block's index among the message's ```ui blocks, as BB counts them. */
  readonly index: number;
  readonly code: string;
}

/** The ```ui blocks of a reply's text that ask something; a block that does not compile asks nothing. */
export function questionBlocks(messageId: string, text: string): QuestionBlock[] {
  return boardSegments(text).flatMap((segment) => {
    if (segment.kind !== "block" || segment.language !== "ui") return [];
    const { program } = compile(segment.code);
    return program !== null && asksQuestion(program) ? [{ messageId, index: segment.index, code: segment.code }] : [];
  });
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

function OpenQuestions({ threadId }: { threadId: string }): ReactElement | null {
  const blocks = useQuestionBlocks(threadId, useOpenReplies(threadId));
  const actions = useThreadActions();
  const [folded, setFolded] = useState(() => readFolded(threadId));
  useEffect(() => setFolded(readFolded(threadId)), [threadId]);
  const scroller = useQuestionInView(blocks, folded);
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
    <section aria-label="Open questions" data-genui-open-questions="" className="mb-1 flex min-w-0 flex-col rounded-lg border border-border bg-background">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={toggle}
        className="flex min-h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 text-left text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="CircleQuestion" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{blocks.length === 1 ? "1 question waits for your answer" : `${blocks.length} questions wait for your answer`}</span>
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
  return composer.scope.kind === "thread" ? <OpenQuestions threadId={composer.scope.threadId} /> : null;
}
