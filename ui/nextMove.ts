// Which ```ui blocks "Your next move" (ui/OpenQuestions.tsx) shows above the
// message field right now. The reply's own copy of such a block folds to one
// line pointing there, so a question is answered in one place. Blocks are
// separate React roots, so this is a module-level store they subscribe to.
import { useSyncExternalStore } from "react";

/** Block key → how many boxes show it: a thread can have more than one message field on screen. */
const shown = new Map<string, number>();
const listeners = new Set<() => void>();

/** A block's key: its reply and its index among the reply's ```ui blocks. */
export const nextMoveKey = (messageId: string, index: number): string => `${messageId}#${index}`;

function changed(): void {
  for (const listener of listeners) listener();
}

/** Puts `keys` in the box in place of what it showed; returns what takes them out again. */
export function showInNextMove(keys: readonly string[]): () => void {
  for (const key of keys) shown.set(key, (shown.get(key) ?? 0) + 1);
  changed();
  return () => {
    for (const key of keys) {
      const count = (shown.get(key) ?? 1) - 1;
      if (count > 0) shown.set(key, count);
      else shown.delete(key);
    }
    changed();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the box shows block `index` of reply `messageId`. */
export function useInNextMove(messageId: string, index: number): boolean {
  const key = nextMoveKey(messageId, index);
  return useSyncExternalStore(subscribe, () => shown.has(key));
}
