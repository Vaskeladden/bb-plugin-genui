// @vitest-environment jsdom
// The banner above the message field: a question a machine message pushed up
// the thread is shown again there, as the same block; a question that is the
// newest turn, or that the user answered, is not.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenQuestionsBanner, questionBlocks } from "./OpenQuestions";

const ASK = '```ui\nCard("Caching", [Button("Use in memory"), Button("Use Redis")])\n```';
const REPORT = '```ui\nCard("Result", [Metric("Tests", "494")])\n```';

const { sdk, scope } = vi.hoisted(() => {
  type Row = { id: string; role: "assistant" | "user"; text: string };
  const user = (thread: string, seq: number, text: string): Row => ({ id: `${thread}:user-seed:${seq}`, role: "user", text });
  const reply = (thread: string, n: number, text: string): Row => ({ id: `${thread}:assistant:${n}`, role: "assistant", text });
  const ask = '```ui\nCard("Caching", [Button("Use in memory"), Button("Use Redis")])\n```';
  const report = '```ui\nCard("Result", [Metric("Tests", "494")])\n```';
  const threads: Record<string, Row[]> = {
    // The question is the newest turn: it stands above the message field already.
    newest: [user("newest", 1, "Plan the cache"), reply("newest", 1, `Which one?\n\n${ask}`)],
    // A CI result arrived after the question.
    pushed: [user("pushed", 1, "Plan the cache"), reply("pushed", 1, `Which one?\n\n${ask}`), user("pushed", 5, "[ci watcher] CI is green on #12"), reply("pushed", 2, "Noted.")],
    // The user wrote after the machine message.
    answered: [
      user("answered", 1, "Plan the cache"),
      reply("answered", 1, `Which one?\n\n${ask}`),
      user("answered", 5, "[ci watcher] CI is green on #12"),
      reply("answered", 2, "Noted."),
      user("answered", 9, "Use Redis"),
    ],
    // What was pushed up asks nothing.
    report: [user("report", 1, "Run the tests"), reply("report", 1, `Done.\n\n${report}`), user("report", 5, "[run watcher] The deploy finished"), reply("report", 2, "Good.")],
  };
  const sdk = {
    subscribe: () => () => {},
    threads: {
      conversationOutline: ({ threadId }: { threadId: string }) =>
        Promise.resolve({ items: (threads[threadId] ?? []).map(({ id, role, text }) => ({ id, role, preview: text.slice(0, 200) })) }),
      // As BB pages it: the newest page holds the newest turn only; the pages before it, the turns asked for.
      timeline: vi.fn(({ threadId, beforeAnchorId }: { threadId: string; beforeAnchorId?: string }) => {
        const rows = (threads[threadId] ?? []).map((row) => ({ ...row, kind: "conversation" }));
        const newest = rows.map((row) => row.role).lastIndexOf("user");
        return Promise.resolve(
          beforeAnchorId === undefined
            ? { rows: rows.slice(newest), timelinePage: { olderCursor: newest > 0 ? { anchorId: "older", anchorSeq: 4 } : null } }
            : { rows: rows.slice(0, newest), timelinePage: { olderCursor: null } },
        );
      }),
    },
  };
  return { sdk, scope: { current: { kind: "thread", threadId: "pushed" } as { kind: string; threadId?: string } } };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposer: () => ({ scope: scope.current }),
  useComposers: () => [],
  useSdk: () => sdk,
  useBbNavigate: () => ({}),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => ({ values: { animations: false }, isLoading: false }),
  experimental_Icon: () => <span aria-hidden="true" />,
}));

let container: HTMLDivElement;
let root: Root;

async function show(threadId: string | null): Promise<void> {
  scope.current = threadId === null ? { kind: "new-thread" } : { kind: "thread", threadId };
  await act(async () => {
    root.render(<OpenQuestionsBanner key={threadId} />);
  });
  // The outline, then the timeline's pages, then the blocks.
  for (let turn = 0; turn < 5; turn++) await act(async () => {});
}

const banner = (): HTMLElement | null => container.querySelector("[data-genui-open-questions]");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  sdk.threads.timeline.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("questionBlocks", () => {
  it("keeps the blocks that ask, with the index BB gives them among the reply's ui blocks", () => {
    expect(questionBlocks("m1", `Results first.\n\n${REPORT}\n\nThen:\n\n${ASK}`)).toEqual([
      { messageId: "m1", index: 1, code: 'Card("Caching", [Button("Use in memory"), Button("Use Redis")])' },
    ]);
  });

  it("finds nothing in prose, in other code, or in a block that does not compile", () => {
    expect(questionBlocks("m1", "Which one, memory or Redis?\n\n```ts\nButton('x')\n```\n\n```ui\nCard(\n```")).toEqual([]);
  });
});

describe("OpenQuestionsBanner", () => {
  it("shows a question a machine message pushed up the thread, as the reply's own block", async () => {
    await show("pushed");
    expect(banner()?.textContent).toContain("1 question waits for your answer");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(expect.arrayContaining(["Use in memory", "Use Redis"]));
    expect(container.querySelector('[data-genui-renderer="composer"] button:disabled')).toBeNull();
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    expect(sdk.threads.timeline).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "pushed", segmentLimit: "2", beforeAnchorId: "older", beforeAnchorSeq: "4" }));
  });

  it("shows nothing while the question is the newest turn, and reads no timeline", async () => {
    await show("newest");
    expect(banner()).toBeNull();
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
  });

  it("shows nothing once the user has written since", async () => {
    await show("answered");
    expect(banner()).toBeNull();
  });

  it("shows nothing when the replies pushed up ask nothing", async () => {
    await show("report");
    expect(sdk.threads.timeline).toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("shows nothing in a new thread's message field", async () => {
    await show(null);
    expect(banner()).toBeNull();
  });

  it("folds on its heading and stays folded for the thread", async () => {
    await show("pushed");
    const heading = banner()?.querySelector("button");
    act(() => heading?.click());
    expect(heading?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-genui-renderer="composer"]')).toBeNull();
    expect(banner()?.textContent).toContain("1 question waits for your answer");
    act(() => root.unmount());
    root = createRoot(container);
    await show("pushed");
    expect(banner()?.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });
});
