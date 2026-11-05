import { threadWorkspaceRoot } from "@t3tools/contracts";
import * as CodespacesWorkspace from "../codespaces/CodespacesWorkspace.ts";
import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

// Check isolation at admission and rollback; checkpoints restore whole checkouts, which may become shared.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
      readonly projects: ProjectStore.ProjectStoreV2["Service"];
      readonly path: Path.Path;
    },
  ) {
    const { fileSystem, projections, projects, path } = dependencies;
    const workspace = Option.getOrUndefined(
      yield* Effect.serviceOption(CodespacesWorkspace.CodespacesWorkspace),
    );
    const canonical = Effect.fn("orchestrationV2.restoreWorkspacePath")(function* (target: string) {
      if (workspace && (yield* workspace.lookup(target))) {
        const metadata = yield* workspace.call<{ path: string } | null>(
          target,
          "worktrees",
          "metadata",
          [target],
        );
        return metadata?.path ?? null;
      }
      return yield* fileSystem.realPath(target).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
    });
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const worktreePath = thread.worktreePath;
    let shared = worktreePath == null;
    if (!shared && worktreePath !== null) {
      // Storage cleanup may have removed the worktree; rollback recreates it.
      const resolve = (target: string) =>
        canonical(target).pipe(Effect.map((value) => value ?? path.resolve(target)));
      const restoreTarget = workspace ? yield* workspace.lookup(scope.cwd) : null;
      const cwd = yield* resolve(scope.cwd);
      const worktreeCwd = yield* resolve(worktreePath);
      shared = cwd !== worktreeCwd;
      if (!shared) {
        const shell = yield* projections.getShellSnapshot();
        const checkedPaths = new Set<string>();
        for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
          if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
          // An idle side chat that only answered questions never touched the shared worktree.
          if (
            otherThread.lineage.sideChat === true &&
            otherThread.activeRunId === null &&
            otherThread.worktreePath === worktreePath
          ) {
            const { turnItems } = yield* projections.getThreadRecords(
              otherThread.id,
              ["turnItems"],
              {
                turnItemTypes: ["command_execution", "file_change", "dynamic_tool"],
              },
            );
            if (turnItems.length === 0) continue;
          }
          const other = yield* projections.getCheckpointContext(otherThread.id);
          const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
          const paths = [
            otherThread.worktreePath,
            ...other.checkpointScopes.map((candidate) => candidate.cwd),
            // Errored sessions can still stream. Shared sessions retain another thread's opening cwd;
            // turn worktrees and project roots are already covered here.
            ...providerContext.providerSessions
              .filter(
                (session) =>
                  session.status !== "stopped" &&
                  !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
              )
              .map((session) => session.cwd),
          ].filter((value): value is string => value !== null);
          if (otherThread.worktreePath === null) {
            const project = yield* projects.get(otherThread.projectId, { includeDeleted: true });
            if (Option.isNone(project)) return false;
            paths.push(threadWorkspaceRoot(otherThread, project.value.workspaceRoot));
          }
          for (const candidate of paths) {
            if (checkedPaths.has(candidate)) continue;
            checkedPaths.add(candidate);
            const candidateTarget = workspace ? yield* workspace.lookup(candidate) : null;
            if (candidateTarget?.name !== restoreTarget?.name) continue;
            const otherCwd = yield* canonical(candidate);
            if (otherCwd !== null && (contains(cwd, otherCwd) || contains(otherCwd, cwd))) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
      }
    }
    return !shared;
  },
);
