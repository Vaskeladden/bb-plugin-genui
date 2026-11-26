// Renderer for BB's experimental_codeFenceRenderer slot (get-bb/bb#5387).
import { useLayoutEffect, useRef } from "react";
import type { ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Fence, useThreadActions, type FenceLanguage } from "./Fence";
import { useInNextMove } from "./nextMove";
import { glideFrom } from "./components/motion";

export const FENCE_LANGUAGES: readonly FenceLanguage[] = ["ui", "app"];

export function SlotFence({ code, language, status, index, message, Original }: ExperimentalCodeFenceRendererProps) {
  const actions = useThreadActions();
  const inNextMove = useInNextMove(message.id, index);
  const box = useFoldGlide(inNextMove);
  if (language !== "ui" && language !== "app") return <Original />;
  // Shown in "Your next move" above the message field: answered there, not twice.
  if (language === "ui" && inNextMove) {
    return (
      <div ref={box} data-genui-fence="" data-genui-renderer="slot" data-genui-in-next-move="" className="my-1 flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="MessageCircle" aria-hidden className="size-3.5 shrink-0" />
        <span>Answer in Your next move below</span>
      </div>
    );
  }
  // Interrupted HTML remains source: never execute a document without its closing fence.
  if (language === "app" && status === "unclosed") return <Original />;
  return (
    <div ref={box} data-genui-fence="" data-genui-renderer="slot">
      <Fence
        language={language}
        code={code}
        complete={status !== "streaming"}
        stateKey={`bb.genui.state:${message.id}#${language}#${index}`}
        threadId={message.threadId}
        messageId={message.id}
        fence={index}
        actions={actions}
      />
    </div>
  );
}

/**
 * When Your next move takes the block (or lets it go) while the reply is on
 * screen, its box glides from its old height to the new one instead of
 * jumping. Both renders use the same root element, so React keeps the node
 * and the height before the swap is still known. A reply that mounts already
 * folded (scrolled back into view) holds still.
 */
function useFoldGlide(folded: boolean) {
  const box = useRef<HTMLDivElement | null>(null);
  const height = useRef<number | null>(null);
  const was = useRef(folded);
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const before = height.current;
    const changed = was.current !== folded;
    was.current = folded;
    if (changed && before !== null) glideFrom(node, before);
  }, [folded]);
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null || typeof ResizeObserver !== "function") return;
    height.current = node.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      height.current = node.getBoundingClientRect().height;
    });
    observer.observe(node);
    return () => observer.disconnect();
  });
  return box;
}
