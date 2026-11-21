// An environment's git status, changed files and patches, read from bb's
// built-in Git plugin (`bb--git`), which took over the SDK's own status and
// diff reads on environments. The schemas below are the part of its contract
// the project components read (`bb plugin rpc inspect bb--git` prints all of it).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Sdk = BbPluginApi["sdk"];

/** bb's built-in plugin that runs git in each environment's checkout. */
export const GIT_PLUGIN = "bb--git";

const notApplicable = z.object({ outcome: z.literal("not_applicable"), message: z.string() });
const unavailable = z.object({
  outcome: z.literal("unavailable"),
  failure: z.object({ code: z.string(), message: z.string(), workspacePath: z.string() }),
});

const checkout = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), branchName: z.string(), headSha: z.string().nullable() }),
  z.object({ kind: z.literal("detached"), headSha: z.string().nullable() }),
  z.object({ kind: z.literal("unborn"), branchName: z.string().nullable() }),
  z.object({ kind: z.literal("unknown"), reason: z.string() }),
]);

const workspace = z.object({
  branch: z.object({ defaultBranch: z.string() }),
  checkout,
  mergeBase: z
    .object({
      aheadCount: z.number(),
      behindCount: z.number(),
      commits: z.array(
        z.object({ sha: z.string(), shortSha: z.string(), subject: z.string(), authorName: z.string(), authoredAt: z.number() }),
      ),
    })
    .nullable(),
  workingTree: z.object({
    files: z.array(z.unknown()),
    insertions: z.number(),
    deletions: z.number(),
    lineStatsComplete: z.boolean(),
  }),
});

const workspaceStatus = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), workspace }),
  notApplicable,
  unavailable,
]);
export type GitWorkspace = z.infer<typeof workspace>;
export type GitWorkspaceStatus = z.infer<typeof workspaceStatus>;

/** What a diff is taken of: the working tree, the branch against its base, or one commit. */
export type GitTarget =
  | { readonly type: "uncommitted" }
  | { readonly type: "all"; readonly mergeBaseBranch: string }
  | { readonly type: "commit"; readonly sha: string };

const patch = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });

const changedFiles = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(
      z.object({
        path: z.string(),
        previousPath: z.string().nullable(),
        changeKind: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
        additions: z.number(),
        deletions: z.number(),
        binary: z.boolean(),
        origin: z.enum(["tracked", "untracked"]),
        loadMode: z.enum(["auto", "on_demand", "too_large"]),
        /** Names the file's content in this list; a patch is asked for by path and revision. */
        revision: z.string(),
      }),
    ),
    truncated: z.boolean(),
    initialPatches: z.array(patch),
  }),
  notApplicable,
  unavailable,
]);
export type GitChangedFiles = z.infer<typeof changedFiles>;
export type GitChangedFile = Extract<GitChangedFiles, { outcome: "available" }>["files"][number];

const patchRows = z.record(
  z.string(),
  z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("available"), patch }), notApplicable, unavailable]),
);
export type GitPatchAnswer = z.infer<typeof patchRows>[string];

/** The checkout's status, compared with `mergeBaseBranch` when given (else the environment's own base). */
export function readWorkspaceStatus(sdk: Sdk, args: { environmentId: string; mergeBaseBranch?: string }): Promise<GitWorkspaceStatus> {
  return sdk.plugins.callRpc({ pluginId: GIT_PLUGIN, method: "workspaceStatus", input: args, outputSchema: workspaceStatus });
}

/** The changed files of a target, with the patches of the small ones. */
export function readChangedFiles(sdk: Sdk, environmentId: string, target: GitTarget): Promise<GitChangedFiles> {
  return sdk.plugins.callRpc({
    pluginId: GIT_PLUGIN,
    method: "files",
    input: { environmentId, target, ignoreWhitespace: false },
    outputSchema: changedFiles,
  });
}

/** The Git plugin's key for one file's patch (its contract's `gitPatchKey`). */
function patchKey(environmentId: string, target: GitTarget, file: { readonly path: string; readonly revision: string }): string {
  return JSON.stringify([environmentId, target, false, file.path, file.revision]);
}

/**
 * The patches of files from a `readChangedFiles` list, in the order asked. The
 * plugin answers at most 50 files per call. A file it has no answer for is left out.
 */
export async function readPatches(
  sdk: Sdk,
  environmentId: string,
  target: GitTarget,
  files: readonly { readonly path: string; readonly revision: string }[],
): Promise<GitPatchAnswer[]> {
  if (files.length === 0) return [];
  const keys = files.map((file) => patchKey(environmentId, target, file));
  const rows = await sdk.plugins.callRpc({ pluginId: GIT_PLUGIN, method: "patches", input: { keys }, outputSchema: patchRows });
  return keys.flatMap((key) => rows[key] ?? []);
}
