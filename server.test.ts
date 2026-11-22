import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
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
    expect(await get(null)).toEqual({ versions: [], shown: null });
    const cli = await host.harness.runCli(["board"], { threadId: ctx.threadId });
    expect(cli.exitCode).toBe(1);
  });

  it("keeps every update as a version of the same board and announces each", async () => {
    const { show, get, host } = await start();
    const first = await show({ content: report("first"), title: "Launch" });
    expect(first).toMatchObject({ isError: false });
    expect(first.text).toContain("version 1 of «Launch», an update (not checked again)");
    expect(first.text).toContain('Keep the board current from now on');
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
      { channel: "board", payload: { threadId: ctx.threadId, id: newest.versions[0]?.id } },
      { channel: "board", payload: { threadId: ctx.threadId, id: newest.versions[1]?.id } },
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

  it("tells the agent of a thread with a board to keep it current, and no other thread", async () => {
    const { show, host } = await start();
    const configure = host.harness.registrations.agentConfigurationProvider!;
    const instructionsFor = host.harness.registrations.instructionProvider!;
    configure(session(ctx.threadId));
    configure(session("thr_other"));
    expect(instructionsFor({ threadId: ctx.threadId, projectId: ctx.projectId })).not.toContain("This thread's status board");
    await show({ content: report("first") });
    expect(instructionsFor({ threadId: ctx.threadId, projectId: ctx.projectId })).toContain("This thread's status board");
    expect(instructionsFor({ threadId: "thr_other", projectId: ctx.projectId })).not.toContain("This thread's status board");
  });

  it("remembers the threads with a board when it starts again", async () => {
    const host = createFakePluginHost({ pluginId: "genui" });
    await host.bb.storage.kv.set("board:thr_kept", [{ id: "a", board: "a", title: "Launch", at: 1 }]);
    await host.bb.storage.kv.set("board:thr_kept:a", { content: report("first") });
    await plugin(host.bb);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.harness.registrations.agentConfigurationProvider!(session("thr_kept"));
    expect(host.harness.registrations.instructionProvider!({ threadId: "thr_kept", projectId: ctx.projectId })).toContain("This thread's status board");
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
    expect(await get(null)).toEqual({ versions: [], shown: null });
    expect(host.harness.realtimeSignals).toEqual([]);
  });

  it("is only another thread's board when asked for that thread", async () => {
    const { show, host } = await start();
    await show({ content: report("first") });
    expect(await host.harness.callRpc("board_get", { threadId: "thr_other", id: null })).toEqual({ versions: [], shown: null });
  });
});
