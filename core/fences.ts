// Fenced code blocks in markdown text: the one place a reply or a board
// document is split into its ```ui and ```app blocks and the prose around them.

export interface Fence {
  /** Line indexes of the opening and closing fence lines. */
  open: number;
  close: number;
  language: string;
  body: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/;

/** Top-level fenced blocks, matching CommonMark's closing rule (same character, at least as long). */
export function findFences(lines: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index] ?? "");
    if (open === null) continue;
    const marker = open[1] ?? "```";
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let close = index + 1;
    while (close < lines.length && !closing.test(lines[close] ?? "")) close++;
    fences.push({
      open: index,
      close,
      language: (open[2] ?? "").toLowerCase(),
      body: lines.slice(index + 1, close).join("\n"),
    });
    index = close;
  }
  return fences;
}
