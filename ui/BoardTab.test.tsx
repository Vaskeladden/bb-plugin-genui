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
    /** The thread's message field, when it is on screen. */
    composers: [] as unknown[],
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
        const { id } = input;
        const shownId = id ?? state.versions.at(-1)?.id ?? null;
        return { versions: state.versions, shown: shownId === null ? null : { id: shownId, content: state.contents[shownId] ?? "" } };
      },
    },
    navigate: {
      openThreadPanel: (options: unknown) => {
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
    useBbNavigate: () => bb.navigate,
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
  act(() => root.render(<BoardTab threadId={THREAD} params={null} />));
  await settle();
}

async function renderOpener(threadId = THREAD): Promise<void> {
  act(() => root.render(<BoardOpener threadId={threadId} projectId="proj" isCompactViewport={false} />));
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
  it("says how to get a board when the thread has none", async () => {
    await renderTab();
    expect(container.textContent).toContain("No status board yet");
    expect(container.querySelector("header")).toBeNull();
  });

  it("shows the newest version: its title, its prose and its block, live", async () => {
    bb.state.versions = [version("a", "a", "Launch", Date.now() - 5 * 60_000)];
    bb.state.contents = { a: report("on track") };
    await renderTab();
    expect(container.querySelector("h2")?.textContent).toBe("Launch");
    expect(container.querySelector("header")?.textContent).toContain("Version 1 · 5 min ago");
    expect(container.querySelector("[data-markdown]")?.textContent).toBe("Bottom line: on track.");
    expect(container.querySelector("[data-genui-fence]")?.textContent).toContain("on track block");
    // One version: nothing to pick.
    expect(container.querySelector("select")).toBeNull();
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
    expect(container.querySelector("header")?.textContent).toContain("Version 3");
  });
});

describe("going on with the work from the board", () => {
  it("asks for an update or a new board, and says so until the report arrives", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("first") };
    await renderTab();
    await act(async () => button("Update")?.click());
    await settle();
    expect(bb.state.requests).toEqual([{ threadId: THREAD, mode: "update" }]);
    expect(container.querySelector("header [role=status]")?.textContent).toContain("Asked the agent for an update");

    await act(async () => button("New board")?.click());
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

  it("says why when the report could not be asked for", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    bb.state.contents = { a: report("first") };
    bb.state.requestResult = { ok: false, message: "plugin jb-flow is not installed" };
    await renderTab();
    await act(async () => button("Update")?.click());
    await settle();
    expect(container.querySelector("header [role=alert]")?.textContent).toBe("Couldn't ask for a report: plugin jb-flow is not installed");
  });

  it("starts the first board from the empty tab", async () => {
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
  it("opens for a version found when the thread is opened, once", async () => {
    bb.state.versions = [version("a", "a", "Launch", 1_000)];
    await renderOpener();
    expect(bb.state.opened).toEqual([{ actionId: "board" }]);
    act(() => root.unmount());
    root = createRoot(container);
    await renderOpener();
    expect(bb.state.opened).toHaveLength(1);
  });

  it("stays shut for a thread without a board", async () => {
    await renderOpener();
    expect(bb.state.opened).toEqual([]);
  });

  it("opens when a version is published in its thread, not in another", async () => {
    await renderOpener();
    act(() => bb.publish({ threadId: "thr_other", id: "x" }));
    expect(bb.state.opened).toEqual([]);
    act(() => bb.publish({ threadId: THREAD, id: "b" }));
    expect(bb.state.opened).toEqual([{ actionId: "board" }]);
    // The same version announced again opens nothing more.
    act(() => bb.publish({ threadId: THREAD, id: "b" }));
    expect(bb.state.opened).toHaveLength(1);
  });

  it("tries again later when BB declined the open", async () => {
    bb.state.accepts = false;
    await renderOpener();
    act(() => bb.publish({ threadId: THREAD, id: "b" }));
    bb.state.accepts = true;
    act(() => bb.publish({ threadId: THREAD, id: "b" }));
    expect(bb.state.opened).toHaveLength(2);
    act(() => bb.publish({ threadId: THREAD, id: "b" }));
    expect(bb.state.opened).toHaveLength(2);
  });
});
