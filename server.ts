// bb-plugin-genui backend. Agents write ```ui and ```app blocks straight into
// their replies, so a UI costs no extra model call. The backend:
// - decides which sessions are told about the blocks, in three sections: the
//   language reference (the instructions of the optional check_ui and
//   ui_examples tools, which let an agent verify a block or see working
//   examples first) and the rules with worked examples (configure instructions),
// - loads the files specs reference with Load(path) and Snippet(path), and
//   the images Image(path) shows,
// - renders replies as plain markdown for clients that don't run the UI
//   (`bb genui render`, the `render_markdown` RPC),
// - serves UIs stored by the retired show_ui pilot tool,
// - does the plugin's only web lookups (web/lookups.ts), behind the
//   `webLookups` setting: photo search, geocoding, map tiles, https images,
// - reads the reply's own thread's state from BB (project/source.ts) for
//   Changes, Commits, PullRequest and Threads, and keeps what Changes and
//   Commits first showed per reply block; and its project's environments
//   (project/environments.ts) for Environments,
// - declares the `animations` setting, which only the page reads,
// - keeps each thread's status boards (board-store.ts): the show_board tool
//   puts a checked report in the thread's side panel, as a new version of the
//   board there or as a new board; `bb genui board` prints the current one.
//   A thread that has a board tells its agent to keep it current (kind
//   "update", which never counts as an Ultrastatus).
import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  listGallery,
  loadGalleryAsset,
  loadGalleryAudio,
  loadGalleryFile,
  loadGalleryImage,
  loadThreadAsset,
  loadThreadAudio,
  loadThreadFile,
  loadThreadImage,
  readGallerySpec,
  sketchFontDataUrl,
} from "./data-source";
import { checkApp, MAX_APP_CHARS } from "./core/appLint";
import { MAX_REPAIRS_IN_A_ROW, repairRequest, unrenderedBlocks } from "./core/reply-check";
import { checkSpec, renderReplyMarkdown } from "./fallback";
import {
  boardSegments,
  CHAT_MESSAGE_EVENTS,
  chatLink,
  chatMessage,
  MAX_BOARD_CHARS,
  MAX_BOARD_TITLE_CHARS,
  MAX_BOARD_VERSIONS,
  kindOf,
  versionNumber,
  type BoardKind,
  type BoardMode,
  type BoardVersion,
} from "./core/board";
import { createBoardStore } from "./board-store";
import { COPY_PURPOSES, createCopies, THREAD_ID } from "./copies";
import type { Value } from "./core/types";
import {
  MAX_PATH_FILTERS,
  MAX_THREAD_IDS,
  parseChangesTarget,
  parsePathFilter,
  type ChangesResult,
  type CommitsResult,
  type PatchesResult,
  type ProjectFailure,
  type PullRequestResult,
  type ThreadsResult,
  type EnvironmentsResult,
} from "./core/project";
import { examplesReport } from "./examples";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_WEB_OFF,
  BOARD_BY_COPY_INSTRUCTIONS,
  BOARD_COPY_REQUEST,
  BOARD_LAYOUT,
  BOARD_START_INSTRUCTIONS,
  BOARD_START_REQUEST,
  BOARD_UPKEEP_INSTRUCTIONS,
  CODE_WORK_INSTRUCTIONS,
  copyInstructions,
  UI_REFERENCE,
  UI_REFERENCE_MORE,
} from "./instructions";
import { foundImageSchema, wikiPhotoSchema } from "./web/commons";
import { locatedSchema } from "./web/geocode";
import { createWebLookups, MAX_TILE_ZOOM } from "./web/lookups";
import { createProjectSource, projectReader } from "./project/source";
import { createEnvironmentsSource } from "./project/environments";
import type { EnvironmentDetailResult } from "./core/environments";

const UI_ID = /^[a-z0-9]{10}$/;

/** Thread ids kept for the code-work instruction section (see configure). */
const MAX_PERSON_THREADS = 10_000;

/** Declared here so BB lists it; the page reads it (ui/components/motion.ts). */
export const MOTION_SETTINGS = {
  animations: {
    type: "boolean",
    label: "Animations",
    description:
      "Lets inline UI move: text fades in, rows and cards rise into place, charts draw, sections glide open, maps and carousels scroll smoothly, and 3D scenes and shaders play. Off, nothing moves: everything appears at once, transitions are instant, and 3D scenes and shaders hold a still frame. The system's reduced-motion setting is honoured either way. Sandboxed apps keep their own motion.",
    default: true,
  },
} as const;

const storedUiSchema = z.object({ source: z.string() });

// parseDataFile builds the value from JSON/CSV text and rejects anything
// posing as an interpreter value, so it is plain data on the wire.
const loadedData = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.custom<Value>() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const loadedImage = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), dataUrl: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const filePath = z.string().min(1).max(1024);

// Project components: the thread is the one whose reply holds the UI;
// `blockKey` (null in the gallery) keeps what Changes and Commits first showed.
const projectThread = z.string().min(1).max(64);
const blockKey = z.string().min(1).max(512).nullable();

/** A web lookup that didn't happen; `off` when the webLookups setting is off. */
const webFailure = z.object({ ok: z.literal(false), error: z.string(), off: z.boolean().optional() });
const webImage = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), dataUrl: z.string() }), webFailure]);

export const rpcContract = defineRpcContract({
  get_ui: {
    input: z.object({ id: z.string().regex(UI_ID) }),
    output: z.object({ source: z.string() }),
  },
  load_data: {
    // `raw` (Snippet) returns the file's text unparsed.
    input: z.object({ threadId: z.string().min(1), path: filePath, raw: z.boolean().optional() }),
    output: loadedData,
  },
  load_image: {
    input: z.object({ threadId: z.string().min(1), path: filePath }),
    output: loadedImage,
  },
  // A recording a Transcript plays (25 MB cap), as a data URL.
  load_audio: {
    input: z.object({ threadId: z.string().min(1), path: filePath }),
    output: loadedImage,
  },
  // A file a Scene loads (glb, gltf, hdr, png, jpg, webp; 10 MB cap), as a data URL the client decodes to bytes.
  load_asset: {
    input: z.object({ threadId: z.string().min(1), path: filePath }),
    output: loadedImage,
  },
  render_markdown: {
    input: z.object({ threadId: z.string().min(1), text: z.string() }),
    output: z.object({ markdown: z.string() }),
  },
  // The UI gallery page: example specs in gallery/, which load files from gallery/.
  gallery_list: {
    input: z.object({}),
    output: z.object({ names: z.array(z.string()) }),
  },
  gallery_get: {
    input: z.object({ name: z.string().min(1).max(200) }),
    output: z.object({ source: z.string() }),
  },
  gallery_data: {
    input: z.object({ path: filePath, raw: z.boolean().optional() }),
    output: loadedData,
  },
  gallery_image: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  gallery_audio: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  gallery_asset: {
    input: z.object({ path: filePath }),
    output: loadedImage,
  },
  // Excalifont for Excalidraw-style diagrams (Diagram), as a data URL.
  sketch_font: {
    input: z.object({}),
    output: z.object({ dataUrl: z.string() }),
  },
  // Web lookups (web/lookups.ts); each answers with a failure value when webLookups is off.
  web_image: {
    input: z.object({ url: z.string().min(1).max(2048) }),
    output: webImage,
  },
  web_search: {
    input: z.object({ query: z.string().min(1).max(200) }),
    output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), image: foundImageSchema }), webFailure]),
  },
  web_photo: {
    input: z.object({ title: z.string().min(1).max(200) }),
    output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), photo: wikiPhotoSchema }), webFailure]),
  },
  web_geocode: {
    input: z.object({ name: z.string().min(1).max(200), near: locatedSchema.nullable() }),
    output: z.discriminatedUnion("ok", [locatedSchema.extend({ ok: z.literal(true) }), webFailure]),
  },
  web_tile: {
    input: z.object({
      z: z.number().int().min(0).max(MAX_TILE_ZOOM),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
    }),
    output: webImage,
  },
  project_changes: {
    input: z.object({
      threadId: projectThread,
      target: z.string().max(64).nullable(),
      paths: z.array(z.string().max(1024)).max(MAX_PATH_FILTERS).nullable(),
      blockKey,
      refresh: z.boolean(),
    }),
    output: z.custom<ChangesResult>(),
  },
  project_patches: {
    input: z.object({
      threadId: projectThread,
      target: z.string().max(64).nullable(),
      paths: z.array(filePath).min(1).max(25),
    }),
    output: z.custom<PatchesResult>(),
  },
  project_commits: {
    input: z.object({ threadId: projectThread, blockKey, refresh: z.boolean() }),
    output: z.custom<CommitsResult>(),
  },
  project_pull_request: {
    input: z.object({ threadId: projectThread }),
    output: z.custom<PullRequestResult>(),
  },
  project_threads: {
    input: z.object({ threadId: projectThread, ids: z.array(z.string().max(64)).max(MAX_THREAD_IDS).nullable() }),
    output: z.custom<ThreadsResult>(),
  },
  // Environments: the list with threads first; each environment's git status and pull request on request.
  project_environments: {
    input: z.object({ threadId: projectThread }),
    output: z.custom<EnvironmentsResult>(),
  },
  project_environment: {
    input: z.object({ threadId: projectThread, environmentId: z.string().min(1).max(64) }),
    output: z.custom<EnvironmentDetailResult>(),
  },
  // The thread's status boards: every version kept, oldest first, and the text
  // of the one asked for (`id` null: the newest). `shown` is null when the
  // thread has no board, or no such version.
  board_get: {
    input: z.object({ threadId: projectThread, id: z.string().min(1).max(64).nullable() }),
    output: z.object({
      versions: z.array(z.custom<BoardVersion>()),
      shown: z.object({ id: z.string(), content: z.string() }).nullable(),
      // The background copy working on this thread's board now, if any: the tab shows it as running.
      copy: z.object({ purpose: z.enum(COPY_PURPOSES), since: z.number() }).nullable(),
    }),
  },
  // Shown a thread without a board: asks its agent once for one, when the
  // thread is idle, not archived and has history (a new thread's agent makes
  // its board in its first turn). `force` (the tab's button) asks again.
  board_start: {
    input: z.object({ threadId: projectThread, force: z.boolean() }),
    output: z.object({ status: z.enum(["asked", "has-board", "already-asked", "busy", "no-history", "archived", "failed"]), message: z.string().optional() }),
  },
  // The board's own Update and New board buttons: asks the thread's agent for
  // a fresh Ultrastatus that lands on the board. The report prompt belongs to
  // the JB Flow plugin, so this passes the request on to it; `ok` false says
  // why it could not (that plugin is not installed, or it refused).
  board_request: {
    input: z.object({ threadId: projectThread, mode: z.enum(["update", "new"]) }),
    output: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), message: z.string() })]),
  },
  // Runs a request (the JB Flow plugin's Status or Ultrastatus) in a hidden
  // background copy of the thread, which publishes to the thread's board, so
  // the thread's own agent is not interrupted. `ok` false: bb refused to fork
  // it (its agent can't be forked); the caller then asks the thread itself.
  copy_run: {
    input: z.object({ threadId: projectThread, text: z.string().min(1).max(100_000), purpose: z.enum(COPY_PURPOSES) }),
    output: z.union([z.object({ ok: z.literal(true), copyId: z.string() }), z.object({ ok: z.literal(false), message: z.string() })]),
  },
});

/** The plugin that owns the Ultrastatus prompt, and the method its own Ultrastatus buttons call. */
const STATUS_PLUGIN = "jb-flow";
const STATUS_REQUEST_METHOD = "thread_status_request";

export default async function plugin(bb: BbPluginApi) {
  const web = createWebLookups(bb);
  bb.settings.define(MOTION_SETTINGS);
  /** Image searches and Wikipedia photos (Map places) for markdown renderings: the photo found, or null (none, or lookups off). */
  const findImage = {
    search: async (query: string) => {
      const found = await web.search(query);
      return found.ok ? found.image : null;
    },
    photo: async (title: string) => {
      const found = await web.photo(title);
      return found.ok ? found.photo : null;
    },
  };
  const project = createProjectSource(bb);
  const environments = createEnvironmentsSource(bb.sdk);

  bb.agents.registerTool({
    name: "check_ui",
    description:
      "Checks a ```ui block before you put it in your reply: compile errors, files Load or Snippet can't read, wrong line ranges, errors its inputs cause once used (each slider end, toggle, option, emptied list), and the text version of what the user will see. Optional; use it for blocks with Load, Snippet or inputs. With language \"app\" it checks a ```app page instead: script syntax, network use, dialogs, genui calls outside a handler.",
    instructions: UI_REFERENCE,
    parameters: z.object({
      // A ```ui spec has its own, smaller cap, which compile reports.
      spec: z.string().min(1).max(MAX_APP_CHARS).describe("The block's content, without the ``` fence lines"),
      language: z.enum(["ui", "app"]).optional().describe('The fence\'s language; default "app" when the content starts with "<", else "ui"'),
    }),
    presentation: { label: { pending: "Checking UI", completed: "Checked UI" }, suppress: true },
    async execute({ spec, language }, ctx) {
      const { ok, report } =
        (language ?? (spec.trimStart().startsWith("<") ? "app" : "ui")) === "app"
          ? checkApp(spec)
          : await checkSpec(
              spec,
              (request) => loadThreadFile(bb, ctx.threadId, request.path, request),
              findImage,
              projectReader(project, environments, ctx.threadId),
            );
      return { content: [{ type: "text", text: report }], isError: !ok };
    },
  });

  bb.agents.registerTool({
    name: "ui_examples",
    description:
      "Returns working ```ui examples of the components you name (from the plugin's gallery), with each component's signature. Optional; use it for a component you haven't written before.",
    instructions: UI_REFERENCE_MORE,
    parameters: z.object({
      components: z.array(z.string().min(1).max(40)).min(1).max(6).describe('Component names, e.g. ["Map", "Chart"]'),
    }),
    presentation: { label: { pending: "Reading UI examples", completed: "Read UI examples" }, suppress: true },
    async execute({ components }) {
      const { ok, text } = await examplesReport(components);
      return { content: [{ type: "text", text }], isError: !ok };
    },
  });

  const boards = createBoardStore(bb);
  /**
   * Threads that have a status board: their sessions are told to keep it
   * current. contributeInstructions must answer synchronously, so this is
   * read once at start and grows with every publish.
   */
  const boardThreads = new Set<string>();
  void boards.threads().then(
    (threads) => threads.forEach((threadId) => boardThreads.add(threadId)),
    (cause: unknown) => bb.log.warn(`board: could not list the threads with a board: ${cause instanceof Error ? cause.message : String(cause)}`),
  );
  /**
   * The chat message a board published now comes after, so an answer picked on
   * it later can link to where the chat stood. Null when the thread's newest
   * events hold no message or can't be read: the board is published either
   * way, and its answers then name the version without the link.
   */
  async function newestChatMessage(threadId: string): Promise<number | null> {
    try {
      return chatMessage(await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "100", types: CHAT_MESSAGE_EVENTS }));
    } catch (cause) {
      bb.log.warn(`board: no chat message found for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }
  /** Checks every block of a board and stores it as a version; a failed check stores nothing. For the show_board tool and `bb genui show-board`. */
  async function publishBoard(
    threadId: string,
    { content, title, mode, kind }: { content: string; title: string | null; mode: BoardMode; kind: BoardKind },
  ): Promise<{ ok: boolean; text: string }> {
    const segments = boardSegments(content);
    if (segments.length === 0) return { ok: false, text: "The board is empty: nothing was stored." };
    const failures: string[] = [];
    for (const segment of segments) {
      if (segment.kind !== "block") continue;
      const { ok, report } =
        segment.language === "app"
          ? checkApp(segment.code)
          : await checkSpec(
              segment.code,
              (request) => loadThreadFile(bb, threadId, request.path, request),
              findImage,
              projectReader(project, environments, threadId),
            );
      if (!ok) failures.push(`${segment.language} block ${segment.index + 1}:\n${report}`);
    }
    if (failures.length > 0) {
      return {
        ok: false,
        text: `Nothing was stored: ${failures.length} block${failures.length === 1 ? "" : "s"} failed the check. Fix and publish again.\n\n${failures.join("\n\n")}`,
      };
    }
    const { added, versions } = await boards.publish(threadId, { content, title, mode, kind, chat: await newestChatMessage(threadId) });
    boardThreads.add(threadId);
    const what = kind === "ultrastatus" ? "an Ultrastatus" : "an update (not checked again)";
    const keep = copies.canCopy(threadId)
      ? "A background copy keeps it current after your turns, at most every 10 minutes; don't publish it again yourself unless the user asks."
      : 'Keep the board current from now on: before you end a turn in which the work moved, publish it again with mode "update" and kind "update", changing only what that turn changed.';
    return {
      ok: true,
      text: `On the status board as version ${versionNumber(versions, added.id)} of «${added.title}», ${what}; the side panel shows it. Don't repeat its content in your reply. ${keep}`,
    };
  }
  bb.agents.registerTool({
    name: "show_board",
    instructions: BOARD_LAYOUT,
    description:
      "Puts a report on this thread's status board: a tab in the thread's side panel, the user's standard view of how the work is going, where a reply would scroll away. Every thread has one. When the thread's instructions say a background copy keeps it, leave it to the copy. Otherwise make it in a thread's first turn, and keep it current: before you end a turn in which the work moved, publish it again with kind \"update\", changing only what that turn changed. Use it too when the user's message asks for the board (an Ultrastatus request does) or asks to put something in the side panel. Pass kind \"ultrastatus\" only for an Ultrastatus request, which checks every row again; an update never counts as one. `content` is what the reply would have been: markdown with ```ui and ```app blocks. Every block is checked as check_ui checks it; if one fails, nothing is stored and you get its errors. Each call is kept as a version the user can go back to. `bb genui board` prints the board that is there. The user can answer from the board: such a message opens with a line naming the board version it was picked on and, as an @thread link, the chat message that version was made after. When the work has moved on since then, print the version (`bb genui board --version <id>`), and say what has changed before you act on the answer.",
    parameters: z.object({
      content: z.string().min(1).max(MAX_BOARD_CHARS).describe("The board: markdown with ```ui and ```app blocks, as a reply would hold them"),
      title: z.string().min(1).max(MAX_BOARD_TITLE_CHARS).optional().describe("A few words naming the board; omitted, an update keeps the board's title"),
      mode: z
        .enum(["update", "new"])
        .optional()
        .describe('"update" (default) adds a version to the board the thread shows; "new" starts another board and leaves the old one in the history'),
      kind: z
        .enum(["ultrastatus", "update"])
        .optional()
        .describe('"update" (default): brought up to date from your own work, without checking every row again. "ultrastatus": only for an Ultrastatus request, every row checked again'),
    }),
    presentation: { label: { pending: "Updating the status board", completed: "Updated the status board" } },
    async execute({ content, title, mode, kind }, ctx) {
      const { ok, text } = await publishBoard((await copies.sourceOf(ctx.threadId)) ?? ctx.threadId, { content, title: title ?? null, mode: mode ?? "update", kind: kind ?? "update" });
      return { content: [{ type: "text", text }], isError: !ok };
    },
  });

  // Threads configure last found to have a person reading their replies. BB
  // resolves configure before it asks instruction contributors, within the
  // same session resolution, so the code-work section below reaches exactly
  // the sessions that get the other three. Bounded; oldest forgotten first.
  const personThreads = new Set<string>();
  const copies = createCopies(bb, { isPersonThread: (threadId) => personThreads.has(threadId) });
  // A reply whose ```ui block does not compile shows the user an error box in
  // place of the block. When such a turn ends, the thread is asked once to
  // send the reply again with the block fixed; MAX_REPAIRS_IN_A_ROW stops a
  // block the agent cannot fix from asking forever. Copies publish through
  // show_board, which checks every block before it stores anything.
  const repairs = new Map<string, number>();
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    try {
      if (lastAssistantText === null || thread.archivedAt !== null || thread.visibility === "hidden") return;
      if ((await copies.sourceOf(thread.id)) !== null) return;
      const failures = unrenderedBlocks(lastAssistantText);
      if (failures.length === 0) {
        repairs.delete(thread.id);
        return;
      }
      const asked = repairs.get(thread.id) ?? 0;
      // A message the user already queued runs next and gets a new reply anyway.
      if (asked >= MAX_REPAIRS_IN_A_ROW || thread.queuedMessageCount > 0) return;
      repairs.set(thread.id, asked + 1);
      await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "queue-if-active",
        originPluginId: bb.pluginId,
        input: [{ type: "text", text: repairRequest(failures), mentions: [] }],
      });
    } catch (cause) {
      bb.log.warn(`repair: could not ask ${thread.id} to fix its reply's UI: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  /** The thread whose board a command run by `threadId` acts on: a copy's source, or the thread itself. */
  const runningFor = async (threadId: string | undefined) => (threadId === undefined ? undefined : ((await copies.sourceOf(threadId)) ?? threadId));
  bb.agents.configure((context) => {
    // A background copy of a thread (copies.ts): the board tools, writing to the thread it copies.
    const { copyOf, purpose } = context.pluginMetadata;
    if (context.origin.kind === "fork" && typeof copyOf === "string" && THREAD_ID.test(copyOf)) {
      personThreads.delete(context.thread.id);
      copies.remember(context.thread.id, copyOf, purpose === "status" || purpose === "ultra" ? purpose : "board");
      return { tools: ["check_ui", "ui_examples", "show_board"], skills: [], instructions: web.isOn() ? AGENT_INSTRUCTIONS : AGENT_INSTRUCTIONS_WEB_OFF };
    }
    // Only sessions whose replies a person reads in chat: not threads another
    // agent spawned (their reply goes back to that agent) and not threads a
    // plugin runs (workflows, automations), except the user's side chats and
    // the subthreads `bb genui ask` opens to try a prompt.
    const forPerson =
      context.pluginMetadata.audience === "person" ||
      (context.thread.parentThreadId === null &&
        (context.origin.pluginId === null || context.origin.pluginId === "side-chat"));
    personThreads.delete(context.thread.id);
    if (!forPerson) return { tools: [], skills: [] };
    personThreads.add(context.thread.id);
    if (personThreads.size > MAX_PERSON_THREADS) personThreads.delete(personThreads.values().next().value!);
    const instructions = web.isOn() ? AGENT_INSTRUCTIONS : AGENT_INSTRUCTIONS_WEB_OFF;
    return { tools: ["check_ui", "ui_examples", "show_board"], skills: [], instructions };
  });
  // Every thread a person reads has a status board: one without is told to make it in this turn.
  bb.agents.contributeInstructions(({ threadId }) => {
    const copyOf = copies.knownSourceOf(threadId);
    if (copyOf !== null) return copyInstructions(copyOf);
    if (!personThreads.has(threadId)) return null;
    // A background copy updates the board after a turn, at most every 10 minutes; a thread that can't be forked keeps its board itself.
    if (copies.canCopy(threadId)) return `${CODE_WORK_INSTRUCTIONS}\n\n${BOARD_BY_COPY_INSTRUCTIONS}`;
    return `${CODE_WORK_INSTRUCTIONS}\n\n${boardThreads.has(threadId) ? BOARD_UPKEEP_INSTRUCTIONS : BOARD_START_INSTRUCTIONS}`;
  });

  bb.rpc.register(rpcContract, {
    async get_ui({ id }) {
      const parsed = storedUiSchema.safeParse(await bb.storage.kv.get(`ui:${id}`));
      if (!parsed.success) throw new Error(`UI ${id} not found`);
      return { source: parsed.data.source };
    },
    load_data: ({ threadId, path, raw }) => loadThreadFile(bb, threadId, path, { raw }),
    load_image: ({ threadId, path }) => loadThreadImage(bb, threadId, path),
    load_audio: ({ threadId, path }) => loadThreadAudio(bb, threadId, path),
    load_asset: ({ threadId, path }) => loadThreadAsset(bb, threadId, path),
    async render_markdown({ threadId, text }) {
      const markdown = await renderReplyMarkdown(
        text,
        (request) => loadThreadFile(bb, threadId, request.path, request),
        findImage,
        projectReader(project, environments, threadId),
      );
      return { markdown };
    },
    gallery_list: async () => ({ names: await listGallery() }),
    gallery_get: async ({ name }) => ({ source: await readGallerySpec(name) }),
    gallery_data: ({ path, raw }) => loadGalleryFile(path, { raw }),
    gallery_image: ({ path }) => loadGalleryImage(path),
    gallery_audio: ({ path }) => loadGalleryAudio(path),
    gallery_asset: ({ path }) => loadGalleryAsset(path),
    sketch_font: async () => ({ dataUrl: await sketchFontDataUrl() }),
    web_image: ({ url }) => web.image(url),
    web_search: ({ query }) => web.search(query),
    web_photo: ({ title }) => web.photo(title),
    web_geocode: ({ name, near }) => web.geocode(name, near),
    web_tile: ({ z: zoom, x, y }) => web.tile(zoom, x, y),
    async project_changes({ threadId, target, paths, blockKey: block, refresh }) {
      const parsedTarget = parseChangesTarget(target);
      if (!parsedTarget.ok) return invalid(parsedTarget.error);
      const parsedPaths = parsePathFilter(paths);
      if (!parsedPaths.ok) return invalid(parsedPaths.error);
      return project.changes(threadId, parsedTarget.value, parsedPaths.value, block === null ? null : { blockKey: block, refresh });
    },
    async project_patches({ threadId, target, paths }) {
      const parsedTarget = parseChangesTarget(target);
      if (!parsedTarget.ok) return invalid(parsedTarget.error);
      return project.patches(threadId, parsedTarget.value, paths);
    },
    project_commits: ({ threadId, blockKey: block, refresh }) =>
      project.commits(threadId, block === null ? null : { blockKey: block, refresh }),
    project_pull_request: ({ threadId }) => project.pullRequest(threadId),
    project_threads: ({ threadId, ids }) => project.threads(threadId, ids),
    project_environments: ({ threadId }) => environments.environments(threadId, false),
    project_environment: ({ threadId, environmentId }) => environments.environment(threadId, environmentId),
    async board_get({ threadId, id }) {
      const versions = await boards.versions(threadId);
      const shownId = id ?? versions.at(-1)?.id ?? null;
      const content = shownId === null ? null : await boards.content(threadId, shownId);
      return { versions, shown: shownId === null || content === null ? null : { id: shownId, content }, copy: copies.activeFor(threadId) };
    },
    async board_start({ threadId, force }) {
      if ((await boards.versions(threadId)).length > 0) return { status: "has-board" as const };
      const askedKey = `boardStart:${threadId}`;
      if (!force && (await bb.storage.kv.get(askedKey)) !== undefined) return { status: "already-asked" as const };
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt !== null) return { status: "archived" as const };
        // A background copy makes it even while the agent works; without one, a running agent
        // makes or keeps its board before the turn ends, as its instructions say.
        const byCopy = copies.canCopy(threadId);
        if (!byCopy && !force && thread.status !== "idle") return { status: "busy" as const };
        if ((await newestChatMessage(threadId)) === null) return { status: "no-history" as const };
        const copy = byCopy ? await copies.run(threadId, BOARD_COPY_REQUEST, "board") : null;
        if (copy?.ok !== true) {
          if (!force && thread.status !== "idle") return { status: "busy" as const };
          await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: BOARD_START_REQUEST, mentions: [] }] });
        }
        await bb.storage.kv.set(askedKey, { at: Date.now() });
        return { status: "asked" as const };
      } catch (cause) {
        return { status: "failed" as const, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    copy_run: ({ threadId, text, purpose }) => copies.run(threadId, text, purpose),
    async board_request({ threadId, mode }) {
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: STATUS_PLUGIN,
          method: STATUS_REQUEST_METHOD,
          input: { threadId, kind: "ultra", board: mode },
          outputSchema: z.object({ ok: z.boolean() }),
        });
        return { ok: true as const };
      } catch (cause) {
        return { ok: false as const, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  bb.cli.register(
    defineCli({
      name: "genui",
      summary: "Read replies that contain inline UI as plain markdown, and a thread's status board",
      commands: {
        ask: cliCommand({
          summary: "Try a prompt in a subthread of this thread whose agent gets the inline UI instructions",
          description:
            "The subthread is deleted with this thread. Wait for it with `bb thread wait <id>` and read it with `bb genui render <id>` or in BB.",
          options: {
            model: { type: "string", description: "Model ID; omitted, the project's default" },
            provider: { type: "string", description: "Provider ID; omitted, the project's remembered provider" },
            title: { type: "string", description: "Subthread title" },
          },
          positionals: [{ name: "prompt", description: "The message to send", required: true }],
          async run(input, ctx) {
            const parentId = ctx.threadId;
            if (parentId === undefined) {
              throw new PluginCliError("ask runs inside a thread", {
                code: "thread_required",
                hint: "Run it from an agent's shell in BB, where BB_THREAD_ID is set",
              });
            }
            const parent = await bb.sdk.threads.get({ threadId: parentId });
            const thread = await bb.sdk.threads.spawn({
              projectId: parent.projectId,
              environment:
                parent.environmentId === null
                  ? { type: "project-default" }
                  : { type: "reuse", environmentId: parent.environmentId },
              parentThreadId: parentId,
              lifecycleOwnerThreadId: parentId,
              prompt: input.positionals.prompt,
              title: input.options.title,
              providerId: input.options.provider,
              model: input.options.model,
              pluginMetadata: { audience: "person" },
            });
            return { exitCode: 0, stdout: `${thread.id}\n` };
          },
        }),
        board: cliCommand({
          summary: "Print a thread's status board as it was published: markdown with its ui and app blocks",
          description:
            "Read it before you update the board, so the next version keeps its rows and order. An answer the user sends from the board names the version it was picked on: print that one with --version.",
          options: {
            version: { type: "string", description: "The id of an earlier version, as an answer from the board names it; omitted, the newest" },
          },
          positionals: [{ name: "thread", description: "Thread ID; defaults to the thread running the command" }],
          async run(input, ctx) {
            const threadId = input.positionals.thread ?? (await runningFor(ctx.threadId));
            if (threadId === undefined) {
              throw new PluginCliError("no thread to read the board of", {
                code: "thread_required",
                hint: "Pass a thread ID: bb genui board thr_…",
              });
            }
            const versions = await boards.versions(threadId);
            const newest = versions.at(-1);
            if (newest === undefined) throw new PluginCliError(`thread ${threadId} has no status board yet`, { code: "no_board" });
            const asked = input.options.version;
            const shown = asked === undefined ? newest : versions.find((candidate) => candidate.id === asked);
            const content = shown === undefined ? null : await boards.content(threadId, shown.id);
            if (shown === undefined || content === null) {
              throw new PluginCliError(`thread ${threadId} has no board version ${asked ?? newest.id}`, {
                code: "no_version",
                hint: `The history keeps the newest ${MAX_BOARD_VERSIONS} versions. The newest is ${newest.id}: bb genui board`,
              });
            }
            const describe = (version: BoardVersion): string => {
              const link = chatLink(threadId, version);
              const made = link === null ? "" : ` at ${link}`;
              const kind = kindOf(version) === "ultrastatus" ? "an Ultrastatus" : "an update, not checked again";
              return `«${version.title}», version ${versionNumber(versions, version.id)} (${kind}), published ${new Date(version.at).toISOString()}${made}`;
            };
            // An earlier version says so, and what replaced it: the work may have moved on since.
            const later = shown.id === newest.id ? "" : `\nNot the newest: ${describe(newest)} (bb genui board) came after it.`;
            return { exitCode: 0, stdout: `${describe(shown)}${later}\n\n${content}\n` };
          },
        }),
        "show-board": cliCommand({
          summary: "Put a markdown file with ui and app blocks on a thread's status board, as the show_board tool does",
          description:
            `For an agent without the show_board tool. The file is one of the thread's: a workspace path or $BB_THREAD_STORAGE/<name>. Every block is checked first; a failed check stores nothing and exits 1.\n\n${BOARD_LAYOUT}`,
          options: {
            title: { type: "string", description: "A few words naming the board; omitted, an update keeps the board's title" },
            new: { type: "boolean", description: "Start another board instead of adding a version to the one the thread shows" },
            ultrastatus: { type: "boolean", description: "Only for an Ultrastatus request, which checked every row again; omitted, the version is an update" },
            thread: { type: "string", description: "Thread ID; defaults to the thread running the command" },
          },
          positionals: [{ name: "file", description: "The board's file", required: true }],
          async run(input, ctx) {
            const threadId = input.options.thread ?? (await runningFor(ctx.threadId));
            if (threadId === undefined) {
              throw new PluginCliError("no thread to put the board on", {
                code: "thread_required",
                hint: "Pass a thread ID: bb genui show-board board.md --thread thr_…",
              });
            }
            // The file is the running thread's own (a copy writes in its own storage); the board is the one it writes for.
            const file = await loadThreadFile(bb, ctx.threadId ?? threadId, input.positionals.file, { raw: true });
            if (!file.ok) throw new PluginCliError(file.error, { code: "file_unreadable" });
            const content = typeof file.value === "string" ? file.value : "";
            if (content.length > MAX_BOARD_CHARS) {
              throw new PluginCliError(`the board is ${content.length} characters; the limit is ${MAX_BOARD_CHARS}`, { code: "too_long" });
            }
            const title = input.options.title?.trim().slice(0, MAX_BOARD_TITLE_CHARS);
            const { ok, text } = await publishBoard(threadId, {
              content,
              title: title === undefined || title === "" ? null : title,
              mode: input.options.new === true ? "new" : "update",
              kind: input.options.ultrastatus === true ? "ultrastatus" : "update",
            });
            return ok ? { exitCode: 0, stdout: `${text}\n` } : { exitCode: 1, stderr: `${text}\n` };
          },
        }),
        render: cliCommand({
          summary: "Print a thread's last reply with its ui and app blocks rendered as markdown",
          positionals: [
            { name: "thread", description: "Thread ID; defaults to the thread running the command" },
          ],
          async run(input, ctx) {
            const threadId = input.positionals.thread ?? ctx.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("no thread to render", {
                code: "thread_required",
                hint: "Pass a thread ID: bb genui render thr_…",
              });
            }
            const { output } = await bb.sdk.threads.output({ threadId });
            if (output === null) {
              throw new PluginCliError(`thread ${threadId} has no completed reply yet`, { code: "no_output" });
            }
            const markdown = await renderReplyMarkdown(
              output,
              (request) => loadThreadFile(bb, threadId, request.path, request),
              findImage,
              projectReader(project, environments, threadId),
            );
            return { exitCode: 0, stdout: `${markdown}\n` };
          },
        }),
      },
    }),
  );
}

function invalid(message: string): ProjectFailure {
  return { ok: false, reason: "invalid", message };
}
