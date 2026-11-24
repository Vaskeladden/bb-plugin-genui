// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardVersion } from "../core/board";
import { BoardOpener, BoardTab } from "./BoardTab";

/** BB's side of the tab: the stored boards, the realtime channel and the panel opener. */
const bb = vi.hoisted(() => {
  const handlers = new Set<(payload: unknown) => void>();
  const state = {
    versions: [] as BoardVersion[],
    contents: {} as Record<string, string>,
    opened: [] as unknown[],
    accepts: true,
    /** What the board's Update and New board asked for, and what the status plugin answers. */
    requests: [] as unknown[],
    requestResult: { ok: true } as { ok: true } | { ok: false; message: string },
    /** What the empty tab asked board_start for, and what the server answers. */
    starts: [] as unknown[],
    startResult: { status: "asked" } as { status: string; message?: string },
    /** The thread's message field, when it is on screen. */
    composers: [] as unknown[],
    /** The background copy working on the board, as board_get reports it. */
    copy: null as { purpose: string; since: number } | null,
  };
  return {
    state,
    handlers,
    publish: (payload: unknown) => handlers.forEach((handler) => handler(payload)),
    rpc: {
      call: async (method: string, input: { threadId: string; id: string | null }) => {
        if (method === "board_request") {
          state.requests.push(input);
          return state.requestResult;
        }
        if (method === "board_start") {
          state.starts.push(input);
          return state.startResult;
        }
        const { id } = input;
        const shownId = id ?? state.versions.at(-1)?.id ?? null;
        return { versions: state.versions, shown: shownId === null ? null : { id: shownId, content: state.contents[shownId] ?? "" }, copy: state.copy };
      },
    },
    panel: {
      openTab: (options: unknown) => {
        state.opened.push(options);
        return state.accepts;
      },
    },
  };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const { useEffect } = await import("react");
  return {
    ...(await importOriginal<typeof PluginSdkApp>()),
    useComposers: () => bb.state.composers,
    useSdk: () => ({}),
    experimental_useAppPanel: () => bb.panel,
    useBbNavigate: () => ({}),
    useRpc: () => bb.rpc,
    useSettings: () => ({ values: { animations: true }, isLoading: false }),
    useRealtime: (_channel: string, handler: (payload: unknown) => void) => {
      useEffect(() => {
        bb.handlers.add(handler);
        return () => void bb.handlers.delete(handler);
      });
    },
    Markdown: ({ content }: { content: string }) => <p data-markdown="">{content}</p>,
    experimental_Icon: () => <span aria-hidden="true" />,
  };
});
vi.mock("./useSuperseded", () => ({ useSuperseded: () => null, useReplyIndex: () => null }));

const THREAD = "thr_board";
/** The open the opener asks bb's side panel for. */
const BOARD_OPEN = { tab: { id: "board", context: { kind: "thread" }, availability: "fixed" } };
const report = (line: string): string => [`Bottom line: ${line}.`, "", "```ui", `Card("Status", [Text("${line} block")])`, "```"].join("\n");
const version = (id: string, board: string, title: string, at: number): BoardVersion => ({ id, board, title, at });
const button = (label: string): HTMLButtonElement | undefined => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

/** A thread message field as BB hands it to a plugin: a draft the answer sheet writes into, and a submit. */
function fakeComposer(threadId: string) {
  const submitted = new Set<() => void>();
  const composer = {
    scope: { kind: "thread", threadId },
    key: `thread:${threadId}`,
    isSubmitting: false,
    draft: { text: "", mentions: [], attachments: [] } as { text: string; mentions: unknown[]; attachments: unknown[] },
    sent: [] as string[],
    blocked: null as string | null,
    replace(next: unknown) {
      const result = typeof next === "function" ? next(composer.draft) : next;
      if (result !== composer.draft) composer.draft = { ...composer.draft, ...result };
    },
    onSubmitted(listener: () => void) {
      submitted.add(listener);
      return () => void submitted.delete(listener);
    },
    async submit() {
      if (composer.blocked !== null) throw new Error(composer.blocked);
      composer.sent.push(composer.draft.text);
      composer.draft = { text: "", mentions: [], attachments: [] };
      submitted.forEach((listener) => listener());
    },
  };
  return composer;
}

let container: HTMLDivElement;
let root: Root;

/** Lets the mocked RPC answer and React commit it. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderTab(): Promise<void> {
  act(() => root.render(<BoardTab threadId={THREAD} environment={null} />));
  await settle();
}

async function renderOpener(threadId = THREAD): Promise<void> {
  act(() => root.render(<BoardOpener threadId={threadId} projectId="proj" environment={null} />));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ addEventListener() {}, removeEventListener() {} }));
  // jsdom has no ResizeObserver or Web Animations, which a rendered block measures and enters with.
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
  window.localStorage.clear();
  bb.state.versions = [];
  bb.state.contents = {};
  bb.state.opened = [];
  bb.state.accepts = true;
  bb.state.requests = [];
  bb.state.requestResult = { ok: true };
  bb.state.copy = null;
  bb.state.starts = [];
  bb.state.startResult = { status: "asked" };
  bb.state.composers = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
});

describe("the Status board tab", () => {
  it("asks the agent for a first board, once, when the thread has none", async () => {
    await renderTab();
    expect(container.textContent).toContain("No status board yet");
    expect(container.querySelector("header")).toBeNull();
    expect(bb.state.starts).toEqual([{ threadId: THREAD, force: false }]);
    expect(container.querySelector("[role=status]")?.textContent).toContain("Asked the agent for a board");

    // Make it now asks again, past the server's once-per-thread guard.
    await act(async () => button("Make it now")?.click());
    await settle();
    expect(bb.state.starts.at(-1)).toEqual({ threadId: THREAD, force: true });
  });

  it("says why no board was asked for", async () => {
    bb.state.startResult = { status: "busy" };
    await renderTab();
    expect(container.querySelector("[role=status]")?.textContent).toContain("The agent is working now");
    bb.state.startResult = { status: "failed", message: "thread not found" };
    await act(async () => button("Make it now")?.click());
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Couldn't ask for a board: thread not found");
  });

  it("asks for nothing when the thread has a board", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("on track") };
    await renderTab();
    expect(bb.state.starts).toEqual([]);
  });

  it("shows the newest version: its title, its prose and its block, live", async () => {
    bb.state.versions = [version("a", "a", "Launch", Date.now() - 5 * 60_000)];
    bb.state.contents = { a: report("on track") };
    await renderTab();
    expect(container.querySelector("header [title=Launch]")?.textContent).toBe("Launch");
    expect(container.querySelector("header")?.textContent).toContain("v1 · 5 min ago");
    expect(container.querySelector("[data-markdown]")?.textContent).toBe("Bottom line: on track.");
    expect(container.querySelector("[data-genui-fence]")?.textContent).toContain("on track block");
    // One version: nothing to pick.
    expect(container.querySelector("select")).toBeNull();
  });

  it("labels an Ultrastatus, and says an update was not checked again and when the last Ultrastatus was", async () => {
    const now = Date.now();
    bb.state.versions = [
      { ...version("a", "a", "Launch", now - 3 * 3_600_000), kind: "ultrastatus" },
      { ...version("b", "a", "Launch", now - 2 * 60_000), kind: "update" },
    ];
    bb.state.contents = { a: report("checked"), b: report("from the work") };
    await renderTab();
    const header = container.querySelector("header")?.textContent ?? "";
    expect(header).toContain("Update, not checked again · last Ultrastatus 3 h ago");
    expect([...container.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      expect.not.stringContaining("Ultrastatus"),
      expect.stringMatching(/^v1 · .+ · Launch · Ultrastatus$/),
    ]);
  });

  it("says when an update has no Ultrastatus before it", async () => {
    bb.state.versions = [{ ...version("a", "a", "Launch", Date.now()), kind: "update" }];
    bb.state.contents = { a: report("from the work") };
    await renderTab();
    expect(container.querySelector("header")?.textContent).toContain("no Ultrastatus in the history");
  });

  it("goes back to an earlier version and says so", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000), version("b", "a", "Launch", 2_000)];
    bb.state.contents = { a: report("first"), b: report("second") };
    await renderTab();
    expect(container.textContent).toContain("second block");
    const select = container.querySelector("select");
    expect(select?.value).toBe("b");
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual(["b", "a"]);

    await act(async () => {
      select!.value = "a";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(container.textContent).toContain("first block");
    expect(container.textContent).toContain("Earlier version");

    const latest = [...container.querySelectorAll("button")].find((button) => button.textContent === "Latest");
    await act(async () => latest?.click());
    await settle();
    expect(container.textContent).toContain("second block");
    expect(container.textContent).not.toContain("Earlier version");
  });

  it("moves to a version published while it is open, even from an earlier one", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000), version("b", "a", "Launch", 2_000)];
    bb.state.contents = { a: report("first"), b: report("second") };
    await renderTab();
    const select = container.querySelector("select");
    await act(async () => {
      select!.value = "a";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    bb.state.versions = [...bb.state.versions, version("c", "a", "Launch", 3_000)];
    bb.state.contents.c = report("third");
    // Another thread's publish changes nothing here.
    act(() => bb.publish({ threadId: "thr_other", id: "x" }));
    await settle();
    expect(container.textContent).toContain("first block");

    act(() => bb.publish({ threadId: THREAD, id: "c" }));
    await settle();
    expect(container.textContent).toContain("third block");
    expect(container.querySelector("header")?.textContent).toContain("v3 ·");
  });
});

describe("going on with the work from the board", () => {
  it("asks for an Ultrastatus or a new board, and says so until the report arrives", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("first") };
    await renderTab();
    await act(async () => button("Ultrastatus")?.click());
    await settle();
    expect(bb.state.requests).toEqual([{ threadId: THREAD, mode: "update" }]);
    expect(container.querySelector("header [role=status]")?.textContent).toContain("Asked the agent for an update");

    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label='New board']")?.click());
    await settle();
    expect(bb.state.requests.at(-1)).toEqual({ threadId: THREAD, mode: "new" });
    expect(container.querySelector("header [role=status]")?.textContent).toContain("a new board");

    // The report it asked for is published: nothing is pending any more.
    bb.state.versions = [...bb.state.versions, version("b", "b", "Launch 2", 2_000)];
    bb.state.contents.b = report("second");
    act(() => bb.publish({ threadId: THREAD, id: "b" }));
    await settle();
    expect(container.querySelector("header [role=status]")).toBeNull();
  });

  it("shows a loader while a background copy runs the Ultrastatus, and blocks a second one", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("first") };
    await renderTab();
    await act(async () => button("Ultrastatus")?.click());
    // The copy starts: the server says so on the board-copy channel.
    bb.state.copy = { purpose: "ultra", since: Date.now() };
    act(() => bb.publish({ threadId: THREAD }));
    await settle();
    expect(container.querySelector("header [role=status]")?.textContent).toContain("Ultrastatus is running in the background · started just now");
    expect(container.querySelector("header svg .animate-spin")).not.toBeNull();
    expect(button("Ultrastatus")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("button[aria-label='New board']")?.disabled).toBe(true);

    // A copy for another thread changes nothing here.
    bb.state.copy = null;
    act(() => bb.publish({ threadId: "thr_other" }));
    await settle();
    expect(container.querySelector("header [role=status]")?.textContent).toContain("Ultrastatus is running");

    // It ends: the loader goes, the buttons come back, and no «Asked…» note is left waiting.
    act(() => bb.publish({ threadId: THREAD }));
    await settle();
    expect(container.querySelector("header [role=status]")).toBeNull();
    expect(button("Ultrastatus")?.disabled).toBe(false);
  });

  it("says an automatic board check runs without blocking the buttons", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("first") };
    bb.state.copy = { purpose: "board", since: Date.now() - 3 * 60_000 };
    await renderTab();
    expect(container.querySelector("header [role=status]")?.textContent).toContain("Checking whether the board needs an update in the background · started 3 min ago");
    expect(button("Ultrastatus")?.disabled).toBe(false);
  });

  it("says why when the report could not be asked for", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("first") };
    bb.state.requestResult = { ok: false, message: "plugin jb-flow is not installed" };
    await renderTab();
    await act(async () => button("Ultrastatus")?.click());
    await settle();
    expect(container.querySelector("header [role=alert]")?.textContent).toBe("Couldn't ask for a report: plugin jb-flow is not installed");
  });

  it("can start the first board with a full Ultrastatus from the empty tab", async () => {
    await renderTab();
    await act(async () => button("Run Ultrastatus")?.click());
    await settle();
    expect(bb.state.requests).toEqual([{ threadId: THREAD, mode: "new" }]);
    expect(container.textContent).toContain("Asked the agent for a new board");
  });

  it("stages a pick in the message field and sends it from the board", async () => {
    const composer = fakeComposer(THREAD);
    bb.state.composers = [composer];
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: ["What next?", "", "```ui", 'Card("Next", [Button("Ship it"), Button("Wait")])', "```"].join("\n") };
    await renderTab();
    // Nothing picked: no bar.
    expect(container.querySelector("footer")).toBeNull();

    await act(async () => button("Ship it")?.click());
    await settle();
    // The answer says which board version it was picked on: the chat may have moved on since.
    const [origin, answer] = composer.draft.text.split("\n");
    expect(origin).toMatch(/^From the status board «Launch», version 1 of .+ \(`bb genui board --version a` prints it\):$/);
    expect(answer).toBe("Ship it");
    expect(container.querySelector("footer")?.textContent).toContain("1 answer ready");

    // BB refuses the send: the bar says why and the answer stays.
    composer.blocked = "Uploads are still running";
    await act(async () => button("Send to chat")?.click());
    await settle();
    expect(container.querySelector("footer [role=alert]")?.textContent).toBe("Not sent: Uploads are still running");
    expect(composer.sent).toEqual([]);

    composer.blocked = null;
    await act(async () => button("Send to chat")?.click());
    await settle();
    expect(composer.sent).toHaveLength(1);
    expect(composer.sent[0]).toMatch(/^From the status board «Launch», version 1 of .+:\nShip it$/);
    expect(container.querySelector("footer")).toBeNull();
  });

  it("names the earlier version when the answer is picked there", async () => {
    const composer = fakeComposer(THREAD);
    bb.state.composers = [composer];
    // Its own version ids: the thread's answer sheet outlives a test, and the one above sent from version «a».
    bb.state.versions = [version("old", "old", "Launch", 1_000), version("new", "old", "Launch", 2_000)];
    const ask = ["What next?", "", "```ui", 'Card("Next", [Button("Ship it"), Button("Wait")])', "```"].join("\n");
    bb.state.contents = { old: ask, new: ask };
    await renderTab();
    const select = container.querySelector("select");
    await act(async () => {
      select!.value = "old";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    await act(async () => button("Wait")?.click());
    await settle();
    expect(composer.draft.text).toMatch(/^From the status board «Launch», version 1 of .+, not the newest \(version 2 is\) \(`bb genui board --version old` prints it\):\nWait$/);
  });
});

describe("opening the tab by itself", () => {
  it("makes the board the view a thread first opens on, and leaves the user's tab alone after that", async () => {
    await renderOpener("thr_arrive");
    expect(bb.state.opened).toEqual([BOARD_OPEN]);
    act(() => root.unmount());
    root = createRoot(container);
    await renderOpener("thr_arrive");
    expect(bb.state.opened).toHaveLength(1);
  });

  it("does not open the board again after a page load", async () => {
    // A page load empties every module; what this browser stored stays.
    window.localStorage.setItem("bb.genui.board.arrived:thr_reloaded", "1");
    await renderOpener("thr_reloaded");
    expect(bb.state.opened).toEqual([]);
  });

  it("tries the first open again on the next visit when BB declined it", async () => {
    bb.state.accepts = false;
    await renderOpener("thr_declined");
    act(() => root.unmount());
    root = createRoot(container);
    bb.state.accepts = true;
    await renderOpener("thr_declined");
    expect(bb.state.opened).toHaveLength(2);
  });

  it("opens when an Ultrastatus lands in its thread, not for an update or another thread", async () => {
    await renderOpener("thr_ultra");
    bb.state.opened = [];
    act(() => bb.publish({ threadId: "thr_other", id: "x", kind: "ultrastatus" }));
    act(() => bb.publish({ threadId: "thr_ultra", id: "a", kind: "update" }));
    expect(bb.state.opened).toEqual([]);
    act(() => bb.publish({ threadId: "thr_ultra", id: "b", kind: "ultrastatus" }));
    expect(bb.state.opened).toEqual([BOARD_OPEN]);
    // The same version announced again opens nothing more.
    act(() => bb.publish({ threadId: "thr_ultra", id: "b", kind: "ultrastatus" }));
    expect(bb.state.opened).toHaveLength(1);
  });

  it("tries an Ultrastatus open again when BB declined it", async () => {
    await renderOpener("thr_retry");
    bb.state.opened = [];
    bb.state.accepts = false;
    act(() => bb.publish({ threadId: "thr_retry", id: "b", kind: "ultrastatus" }));
    bb.state.accepts = true;
    act(() => bb.publish({ threadId: "thr_retry", id: "b", kind: "ultrastatus" }));
    expect(bb.state.opened).toHaveLength(2);
    act(() => bb.publish({ threadId: "thr_retry", id: "b", kind: "ultrastatus" }));
    expect(bb.state.opened).toHaveLength(2);
  });
});
