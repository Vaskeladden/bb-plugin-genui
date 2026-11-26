// A finished reply's ```ui blocks that BB shows as «This UI couldn't be
// rendered», and the message that asks the thread to send the reply again.
import { boardSegments } from "./board";
import { findFences } from "./fences";
import { compile, formatDiagnostics } from "./index";

/** One report per ```ui block of `text` that does not compile, as `ui block 2:\n3:5 error: …`. */
export function unrenderedBlocks(text: string): string[] {
  const lines = text.split("\n");
  // A reply cut off inside a block (a stopped turn) is not a finished reply.
  if (findFences(lines).some((fence) => fence.close >= lines.length)) return [];
  const failures: string[] = [];
  for (const segment of boardSegments(text)) {
    if (segment.kind !== "block" || segment.language !== "ui") continue;
    const errors = compile(segment.code).diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) failures.push(`ui block ${segment.index + 1}:\n${formatDiagnostics(errors)}`);
  }
  return failures;
}

/** Repair requests a thread gets in a row before genui stops asking: a block the agent cannot fix stays as it is. */
export const MAX_REPAIRS_IN_A_ROW = 2;

export function repairRequest(failures: readonly string[]): string {
  const blocks = failures.length === 1 ? "A ```ui block" : `${failures.length} \`\`\`ui blocks`;
  return [
    `[genui] ${blocks} in your last reply did not render: the user sees «This UI couldn't be rendered» and these errors instead of it.`,
    "",
    failures.join("\n\n"),
    "",
    "Send your last reply again in full, with every block fixed; check each with check_ui first when you have it. Change nothing else, and do not mention the fix.",
  ].join("\n");
}
