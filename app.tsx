// bb-plugin-genui frontend. Agents write ```ui and ```app blocks in their
// replies; BB hands those fences to SlotFence through its code-fence renderer slot.
// The `::ui{id="…"}` directive keeps UIs stored by the show_ui pilot rendering.
// The Gen-UI Gallery page renders the example specs in gallery/.
// The Status board tab shows the report a thread's agent published with
// show_board, and opens by itself when a new version arrives.
// The open-questions banner keeps a thread's unanswered questions above its
// message field once machine messages have pushed them up the thread.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BOARD_TAB, BOARD_TITLE, BoardOpener, BoardTab } from "./ui/BoardTab";
import { FENCE_LANGUAGES, SlotFence } from "./ui/SlotFence";
import { GalleryPanel } from "./ui/GalleryPanel";
import { OpenQuestionsBanner } from "./ui/OpenQuestions";
import { UiDirective } from "./ui/UiDirective";

export default definePluginApp((app) => {
  app.slots.experimental_codeFenceRenderer({ id: "genui", languages: FENCE_LANGUAGES, component: SlotFence });
  app.slots.experimental_tab({ ...BOARD_TAB, title: BOARD_TITLE, icon: "LayoutDashboard", component: BoardTab, layout: "flush" });
  // Mounted with every visible thread, so a publish opens that thread's tab. It renders nothing, so the row takes no space.
  app.slots.experimental_threadHeaderRow({ id: "board-opener", component: BoardOpener });
  app.composer.customize({ id: "open-questions", scopes: ["thread"], banners: [{ id: "open-questions", chrome: "bare", component: OpenQuestionsBanner }] });
  app.slots.messageDirective({ id: "ui", component: UiDirective });
  app.slots.navPanel({ id: "gallery", title: "Gen-UI Gallery", icon: "GridView", path: "gallery", component: GalleryPanel });
});
