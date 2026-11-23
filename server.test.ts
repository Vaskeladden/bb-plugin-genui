import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";

describe("the plugin's settings", () => {
  it("lists Animations, on by default, beside Web lookups", async () => {
    const host = createFakePluginHost({ pluginId: "genui" });
    await plugin(host.bb);
    expect(host.harness.registrations.settingsDescriptors).toMatchObject({
      animations: { type: "boolean", label: "Animations", default: true },
      webLookups: { type: "boolean", label: "Web lookups", default: true },
    });
  });
});

describe("the status board", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const ctx = { threadId: "thr_board", projectId: "proj_1", signal: new AbortController().signal };
  const report = (line: string): string => ["On track.", "", "```ui", `Card("Status", [Text("${line}")])`, "```"].join("\n");
  /** A session a person reads, as BB resolves it for the configure hook. */
  const session = (id: string) => ({
    pluginMetadata: {},
    thread: { id, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: ctx.projectId, kind: "standard" as const, name: "p", gitRemoteUrl: null },
    environment: { id: "env", name: null, path: null, branchName: null, workspaceProvisionType: null },
    host: { id: "h", name: "h" },
    provider: { id: "claude-code", model: "m", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: null },
  });

  async function start() {
    const host = createFakePluginHost({ pluginId: "genui" });
    await plugin(host.bb);
    const tool = host.harness.registrations.agentTools.find((candidate) => candidate.name === "show_board");
    if (tool === undefined) throw new Error("show_board is not registered");
    const show = async (input: unknown) => {
      const parsed = tool.parse(input);
      if (!parsed.ok) throw new Error(parsed.error);
      const result = await tool.execute(parsed.value, ctx);
      if (typeof result === "string") return { isError: false, text: result };
      return { isError: result.isError === true, text: result.content.map((part) => (part.type === "text" ? part.text : "")).join("") };
    };
    const get = (id: string | null) =>
      host.harness.callRpc("board_get", { threadId: ctx.threadId, id }) as Promise<{
        versions: { id: string; board: string; title: string; at: number; chat?: number | null; kind?: string }[];
        shown: { id: string; content: string } | null;
      }>;
    return { host, show, get };
  }

  it("passes the board's Update and New board on to the status plugin, and says why when it can't", async () => {
    const { host } = await start();
    host.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, children: 2 }));
    expect(await host.harness.callRpc("board_request", { threadId: ctx.threadId, mode: "new" })).toEqual({ ok: true });
    expect(host.harness.sdk.callsTo("plugins.callRpc").at(-1)?.[0]).toMatchObject({
      pluginId: "jb-flow",
      method: "thread_status_request",
      input: { threadId: ctx.threadId, kind: "ultra", board: "new" },
    });

    host.harness.sdk.stub("plugins.callRpc", async () => {
      throw new Error("plugin jb-flow is not installed");
    });
    expect(await host.harness.callRpc("board_request", { threadId: ctx.threadId, mode: "update" })).toEqual({
      ok: false,
      message: "plugin jb-flow is not installed",
    });
  });

  it("has no board until one is published", async () => {
    const { get, host } = await start();
    expect(await get(null)).toEqual({ versions: [], shown: null, copy: null });
    const cli = await host.harness.runCli(["board"], { threadId: ctx.threadId });
    expect(cli.exitCode).toBe(1);
  });

  it("keeps every update as a version of the same board and announces each", async () => {
    const { show, get, host } = await start();
    const first = await show({ content: report("first"), title: "Launch" });
    expect(first).toMatchObject({ isError: false });
    expect(first.text).toContain("version 1 of «Launch», an update (not checked again)");
    expect(first.text).toContain("A background copy keeps it current after your turns, at most every 10 minutes");
    const second = await show({ content: report("second") });
    expect(second.text).toContain("version 2 of «Launch»");

    const newest = await get(null);
    expect(newest.versions.map(({ title, board }) => [title, board])).toEqual([
      ["Launch", newest.versions[0]?.id],
      ["Launch", newest.versions[0]?.id],
    ]);
    expect(newest.shown).toEqual({ id: newest.versions[1]?.id, content: report("second") });
    // The earlier version is still what it was.
    expect((await get(newest.versions[0]!.id)).shown?.content).toBe(report("first"));
    expect(host.harness.realtimeSignals).toEqual([
      { channel: "board", payload: { threadId: ctx.threadId, id: newest.versions[0]?.id, kind: "update" } },
      { channel: "board", payload: { threadId: ctx.threadId, id: newest.versions[1]?.id, kind: "update" } },
    ]);

    const cli = await host.harness.runCli(["board"], { threadId: ctx.threadId });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("«Launch», version 2 (an update, not checked again)");
    expect(cli.stdout).toContain(report("second"));
    expect(cli.stdout).not.toContain("Not the newest");

    // An answer from the board names the version it was picked on: that one can be printed, and says it was replaced.
    const earlier = await host.harness.runCli(["board", "--version", newest.versions[0]!.id], { threadId: ctx.threadId });
    expect(earlier.exitCode).toBe(0);
    expect(earlier.stdout).toContain("«Launch», version 1 (an update, not checked again), published");
    expect(earlier.stdout).toContain("Not the newest: «Launch», version 2");
    expect(earlier.stdout).toContain(report("first"));
    const missing = await host.harness.runCli(["board", "--version", "nope"], { threadId: ctx.threadId });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("no board version nope");
  });

  it("records the chat message a version was made after, and prints it as a link", async () => {
    const { show, get, host } = await start();
    host.harness.sdk.stub("threads.events.list", async () => [
      { seq: 41, type: "item/completed", data: { item: { type: "commandExecution" } } },
      { seq: 40, type: "item/completed", data: { item: { type: "agentMessage" } } },
      { seq: 12, type: "client/turn/requested", data: {} },
    ]);
    await show({ content: report("first"), title: "Launch" });
    expect(host.harness.sdk.callsTo("threads.events.list").at(-1)?.[0]).toMatchObject({
      threadId: ctx.threadId,
      order: "desc",
      types: ["client/turn/requested", "item/completed"],
    });
    expect((await get(null)).versions[0]).toMatchObject({ chat: 40 });
    const cli = await host.harness.runCli(["board"], { threadId: ctx.threadId });
    expect(cli.stdout).toContain(` at @thread:${ctx.threadId}#msg=40`);
  });

  it("publishes without the link when the thread's events can't be read", async () => {
    const { show, get, host } = await start();
    host.harness.sdk.stub("threads.events.list", async () => {
      throw new Error("HTTP 500");
    });
    expect(await show({ content: report("first") })).toMatchObject({ isError: false });
    expect((await get(null)).versions[0]).toMatchObject({ chat: null });
    const cli = await host.harness.runCli(["board"], { threadId: ctx.threadId });
    expect(cli.stdout).not.toContain("#msg=");
  });

  it("counts a version as an Ultrastatus only when it says it is one", async () => {
    const { show, get, host } = await start();
    const ultra = await show({ content: report("checked"), title: "Launch", kind: "ultrastatus" });
    expect(ultra.text).toContain("version 1 of «Launch», an Ultrastatus");
    await show({ content: report("from the work") });
    expect((await get(null)).versions.map(({ kind }) => kind)).toEqual(["ultrastatus", "update"]);
    const cli = await host.harness.runCli(["board", "--version", (await get(null)).versions[0]!.id], { threadId: ctx.threadId });
    expect(cli.stdout).toContain("«Launch», version 1 (an Ultrastatus), published");
  });

  it("leaves the board to a background copy, and tells a thread that can't be copied to make and keep it itself", async () => {
    const { show, host } = await start();
    const configure = host.harness.registrations.agentConfigurationProvider!;
    const instructionsFor = host.harness.registrations.instructionProvider!;
    configure(session(ctx.threadId));
    configure(session("thr_other"));
    const copied = instructionsFor({ threadId: ctx.threadId, projectId: ctx.projectId });
    expect(copied).toContain("A background copy of you brings it up to date after your turns (at most every 10 minutes)");
    expect(copied).not.toContain("This thread has none yet");

    // bb refuses to fork these threads (their agent can't be forked): they keep their board themselves.
    host.harness.sdk.stub("threads.fork", async () => {
      throw new Error("provider does not support fork");
    });
    for (const threadId of [ctx.threadId, "thr_other"]) {
      expect(await host.harness.callRpc("copy_run", { threadId, text: "Status", purpose: "status" })).toEqual({ ok: false, message: "provider does not support fork" });
    }
    const before = instructionsFor({ threadId: ctx.threadId, projectId: ctx.projectId });
    expect(before).toContain("This thread has none yet");
    expect(before).not.toContain("This thread has a status board");
    await show({ content: report("first") });
    expect(instructionsFor({ threadId: ctx.threadId, projectId: ctx.projectId })).toContain("This thread has a status board");
    expect(instructionsFor({ threadId: "thr_other", projectId: ctx.projectId })).toContain("This thread has none yet");
  });

  it("has a background copy make a thread's first board, once, even while its agent works", async () => {
    const { show, host } = await start();
    const thread = { status: "running", archivedAt: null as number | null };
    host.harness.sdk.stub("threads.get", async () => thread);
    host.harness.sdk.stub("threads.fork", async () => ({ id: "thr_copy01" }));
    const events = [{ seq: 4, type: "item/completed", data: { item: { type: "agentMessage" } } }];
    host.harness.sdk.stub("threads.events.list", async () => events);
    const begin = (force = false) => host.harness.callRpc("board_start", { threadId: ctx.threadId, force });

    thread.archivedAt = 1;
    expect(await begin()).toEqual({ status: "archived" });
    thread.archivedAt = null;
    events.length = 0;
    expect(await begin()).toEqual({ status: "no-history" });
    expect(host.harness.sdk.callsTo("threads.fork")).toEqual([]);

    events.push({ seq: 4, type: "item/completed", data: { item: { type: "agentMessage" } } });
    expect(await begin()).toEqual({ status: "asked" });
    expect(host.harness.sdk.callsTo("threads.fork").at(-1)?.[0]).toMatchObject({
      sourceThreadId: ctx.threadId,
      visibility: "hidden",
      lifecycleOwnerThreadId: ctx.threadId,
      pluginMetadata: { copyOf: ctx.threadId, purpose: "board" },
      input: [{ type: "text", text: expect.stringContaining("[status board] The thread's last turn just ended") }],
    });
    expect(host.harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(await begin()).toEqual({ status: "already-asked" });

    await show({ content: report("first") });
    expect(await begin(true)).toEqual({ status: "has-board" });
  });

  it("asks a thread that can't be copied for its first board, once, and only when that makes sense", async () => {
    const { host } = await start();
    const thread = { status: "idle", archivedAt: null as number | null };
    host.harness.sdk.stub("threads.get", async () => thread);
    host.harness.sdk.stub("threads.send", async () => undefined);
    host.harness.sdk.stub("threads.fork", async () => {
      throw new Error("provider does not support fork");
    });
    await host.harness.callRpc("copy_run", { threadId: ctx.threadId, text: "Status", purpose: "status" });
    const events = [{ seq: 4, type: "item/completed", data: { item: { type: "agentMessage" } } }];
    host.harness.sdk.stub("threads.events.list", async () => events);
    const begin = (force = false) => host.harness.callRpc("board_start", { threadId: ctx.threadId, force });

    thread.status = "running";
    expect(await begin()).toEqual({ status: "busy" });
    thread.status = "idle";
    expect(await begin()).toEqual({ status: "asked" });
    expect(host.harness.sdk.callsTo("threads.send").at(-1)?.[0]).toMatchObject({
      threadId: ctx.threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text: expect.stringContaining("[status board] This thread has no status board yet") }],
    });
    expect(await begin()).toEqual({ status: "already-asked" });
    expect(await begin(true)).toEqual({ status: "asked" });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(2);

    host.harness.sdk.stub("threads.get", async () => {
      throw new Error("thread not found");
    });
    expect(await host.harness.callRpc("board_start", { threadId: "thr_gone", force: false })).toEqual({ status: "failed", message: "thread not found" });
  });

  it("updates the board in a background copy after a turn, at most once every 10 minutes, one copy at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { host } = await start();
    host.harness.registrations.agentConfigurationProvider!(session(ctx.threadId));
    let next = 0;
    host.harness.sdk.stub("threads.fork", async () => ({ id: `thr_copy0${++next}` }));
    host.harness.sdk.stub("threads.delete", async () => ({ ok: true }));
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }));
    const forks = () => host.harness.sdk.callsTo("threads.fork").length;
    const idle = (id: string, text: string | null = "Done.") =>
      host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id }), lastAssistantText: text });

    await idle(ctx.threadId);
    expect(forks()).toBe(1);
    // The board tab shows the copy as running, and hears when it starts and ends.
    const copyOf = async () => ((await host.harness.callRpc("board_get", { threadId: ctx.threadId, id: null })) as { copy: unknown }).copy;
    expect(await copyOf()).toEqual({ purpose: "board", since: expect.any(Number) });
    expect(host.harness.realtimeSignals).toContainEqual({ channel: "board-copy", payload: { threadId: ctx.threadId } });
    // Another turn ends while that copy runs: no second copy now.
    await idle(ctx.threadId);
    expect(forks()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await idle("thr_copy01", "Board updated.");
    expect(host.harness.sdk.callsTo("threads.delete").at(-1)?.[0]).toMatchObject({ threadId: "thr_copy01" });
    expect(await copyOf()).toBeNull();
    expect(host.harness.realtimeSignals.filter((signal) => signal.channel === "board-copy")).toHaveLength(2);
    // The turn that ended meanwhile, and the next ones, wait for the gap: one update covers them all.
    expect(forks()).toBe(1);
    await idle(ctx.threadId);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await idle(ctx.threadId);
    expect(forks()).toBe(1);
    expect(await host.bb.storage.kv.get(`boardDue:${ctx.threadId}`)).toMatchObject({ at: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(forks()).toBe(2);
    expect(await host.bb.storage.kv.get(`boardDue:${ctx.threadId}`)).toBeUndefined();
    await idle("thr_copy02", "Nothing changed.");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(forks()).toBe(2);

    // Ten minutes after the last copy a turn gets its update at once.
    await idle(ctx.threadId);
    expect(forks()).toBe(3);

    // Threads no person reads (spawned by an agent or a plugin) get no copy.
    await idle("thr_unread");
    expect(forks()).toBe(3);
  });

  it("skips a planned board update of a thread archived while it waited, and keeps one across a reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const host = createFakePluginHost({ pluginId: "genui" });
    await host.bb.storage.kv.set("boardDue:thr_kept", { at: Date.now() + 60_000 });
    await host.bb.storage.kv.set("boardDue:thr_gone", { at: Date.now() + 60_000 });
    await plugin(host.bb);
    host.harness.sdk.stub("threads.fork", async () => ({ id: "thr_copy01" }));
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, archivedAt: threadId === "thr_gone" ? Date.now() : null }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.harness.sdk.callsTo("threads.fork").map(([args]) => (args as { sourceThreadId: string }).sourceThreadId)).toEqual(["thr_kept"]);
    expect(await host.bb.storage.kv.list("boardDue:")).toEqual([]);
  });

  it("puts what a copy publishes on the board of the thread it copies", async () => {
    const { host, get } = await start();
    const configure = host.harness.registrations.agentConfigurationProvider!;
    const copySession = { ...session("thr_copy01"), pluginMetadata: { copyOf: ctx.threadId, purpose: "ultra" }, origin: { kind: "fork" as const, pluginId: "genui" } };
    const configured = configure(copySession);
    expect(configured.tools).toContain("show_board");
    // A copy is not a thread a person reads: it is told it is a copy, and gets no board of its own.
    const copyText = host.harness.registrations.instructionProvider!({ threadId: "thr_copy01", projectId: ctx.projectId });
    expect(copyText).toContain(`You are a hidden copy of thread ${ctx.threadId}`);
    expect(copyText).not.toContain("This thread's status board");

    const result = await host.harness.callAgentTool("show_board", { content: report("from the copy"), kind: "ultrastatus" }, { threadId: "thr_copy01" });
    expect(JSON.stringify(result)).toContain("an Ultrastatus");
    expect((await get(null)).versions).toHaveLength(1);
    expect(await host.harness.callRpc("board_get", { threadId: "thr_copy01", id: null })).toEqual({ versions: [], shown: null, copy: null });

    const cli = await host.harness.runCli(["board"], { threadId: "thr_copy01" });
    expect(cli.stdout).toContain("from the copy");

    // Metadata anyone can write never points a copy at something that is not a thread id.
    expect(configure({ ...session("thr_copy02"), pluginMetadata: { copyOf: "../etc" }, origin: { kind: "fork" as const, pluginId: "genui" } }).tools).toEqual([]);
    expect(host.harness.registrations.instructionProvider!({ threadId: "thr_copy02", projectId: ctx.projectId })).toBeNull();
  });

  it("gives every board the plain-words layout, with the tool and without it", async () => {
    const { host } = await start();
    const tool = host.harness.registrations.agentTools.find((candidate) => candidate.name === "show_board");
    expect(tool?.instructions).toContain("**What I need from you:**");
    const help = await host.harness.runCli(["show-board", "--help"], { threadId: ctx.threadId });
    expect(`${help.stdout}${help.stderr}`).toContain("**What I need from you:**");
  });

  it("remembers the threads with a board, and those it can't copy, when it starts again", async () => {
    const host = createFakePluginHost({ pluginId: "genui" });
    await host.bb.storage.kv.set("board:thr_kept", [{ id: "a", board: "a", title: "Launch", at: 1 }]);
    await host.bb.storage.kv.set("board:thr_kept:a", { content: report("first") });
    await host.bb.storage.kv.set("noCopy:thr_kept", { at: Date.now() });
    await plugin(host.bb);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.harness.registrations.agentConfigurationProvider!(session("thr_kept"));
    expect(host.harness.registrations.instructionProvider!({ threadId: "thr_kept", projectId: ctx.projectId })).toContain("This thread has a status board");
  });

  it("starts another board on mode «new» and leaves the old one in the history", async () => {
    const { show, get } = await start();
    await show({ content: report("first"), title: "Launch" });
    const fresh = await show({ content: report("again"), mode: "new" });
    expect(fresh.text).toContain("version 1 of «Status»");
    const { versions } = await get(null);
    expect(versions).toHaveLength(2);
    expect(versions[1]?.board).toBe(versions[1]?.id);
    expect(versions[0]?.board).toBe(versions[0]?.id);
  });

  it("stores nothing when a block fails its check", async () => {
    const { show, get, host } = await start();
    const broken = await show({ content: ["Text first.", "```ui", 'Card("Open", [', "```"].join("\n") });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("Nothing was stored");
    expect(broken.text).toContain("ui block 1");
    expect(await get(null)).toEqual({ versions: [], shown: null, copy: null });
    expect(host.harness.realtimeSignals).toEqual([]);
  });

  it("is only another thread's board when asked for that thread", async () => {
    const { show, host } = await start();
    await show({ content: report("first") });
    expect(await host.harness.callRpc("board_get", { threadId: "thr_other", id: null })).toEqual({ versions: [], shown: null, copy: null });
  });
});
