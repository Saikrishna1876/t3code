import { CodespacesError, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DocumentText from "../provider/DocumentText.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { CodespacesWorkspace } from "./CodespacesWorkspace.ts";

/** Provider inputs keep native image data; file references must name the executor's filesystem. */
export const resolveCodexWorkspaceAttachments = Effect.fn(
  "CodexWorkspaceAttachments.resolveCodexWorkspaceAttachments",
)(function* (
  workspace: CodespacesWorkspace["Service"] | undefined,
  input: { cwd: string | null; attachmentsDir: string; attachments: ReadonlyArray<ChatAttachment> },
) {
  const target = workspace && input.cwd ? yield* workspace.lookup(input.cwd) : null;
  const paths = new Map<string, string>();
  for (const attachment of input.attachments) {
    const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    if (path === null) {
      if (target && (attachment.type === "image" || attachment.type === "file"))
        return yield* new CodespacesError({
          code: "configuration",
          message: "Invalid attachment path.",
        });
      continue;
    }
    paths.set(
      attachment.id,
      target && workspace && input.cwd
        ? yield* workspace.stageAttachment({ cwd: input.cwd, path })
        : path,
    );
  }
  return paths;
});

export const resolveWorkspaceExtractedTextPath = Effect.fn(
  "CodexWorkspaceAttachments.resolveWorkspaceExtractedTextPath",
)(function* (
  workspace: CodespacesWorkspace["Service"] | undefined,
  input: {
    cwd: string | null;
    path: string;
    attachmentsDir: string;
    attachments: ReadonlyArray<ChatAttachment>;
    attachmentPaths?: ReadonlyMap<string, string>;
  },
) {
  const attachment = input.attachments.find(
    (attachment) => input.attachmentPaths?.get(attachment.id) === input.path,
  );
  const localPath = attachment
    ? resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment })
    : input.path;
  if (localPath === null) return;
  const extracted = yield* DocumentText.resolveExtractedTextPath(localPath);
  if (extracted === undefined) return;
  const target = workspace && input.cwd ? yield* workspace.lookup(input.cwd) : null;
  return target && workspace && input.cwd
    ? yield* workspace.stageAttachment({ cwd: input.cwd, path: extracted })
    : extracted;
});
