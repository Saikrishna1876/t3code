import { CodespacesError, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { CodespacesWorkspace } from "./CodespacesWorkspace.ts";

/** Provider inputs keep native image data; file references must name the executor's filesystem. */
export const resolveCodexWorkspaceAttachments = (
  workspace: CodespacesWorkspace["Service"] | undefined,
  input: { cwd: string | null; attachmentsDir: string; attachments: ReadonlyArray<ChatAttachment> },
) =>
  Effect.gen(function* () {
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
