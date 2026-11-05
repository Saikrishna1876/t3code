import * as CodespacesWorkspace from "../codespaces/CodespacesWorkspace.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodespacesError,
  CheckpointId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2, type ProjectionCheckpointRollbackContext } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "provider",
  "sibling",
  "shared-provider",
  "conversation",
  "offline-codespace",
  "different-codespace",
  "same-codespace",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
      worktreePath:
        owner === "ancestor" || owner === "conversation"
          ? parent
          : ["nested", "offline-codespace", "different-codespace", "same-codespace"].includes(owner)
            ? nested
            : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThread,
      providerSession: undefined,
      providerTurns: [],
      rootNodes: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
      scope: { id: scopeId, cwd },
      runsToRollback: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as ProjectionCheckpointRollbackContext;
    const workspaceLayer = Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
      lookup: (target) =>
        Effect.succeed(
          owner === "offline-codespace" && target === nested
            ? ({ name: "offline" } as never)
            : owner === "different-codespace" || owner === "same-codespace"
              ? ({
                  name:
                    target === nested && owner === "different-codespace" ? "offline" : "current",
                } as never)
              : null,
        ),
      call: (target) =>
        target === nested && owner !== "same-codespace"
          ? (Effect.fail(
              new CodespacesError({ code: "conflict", message: "Codespace is disconnected" }),
            ) as never)
          : (Effect.succeed({ path: target }) as never),
    });
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          workspaceLayer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [otherThread] as never,
                archivedThreads: [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions:
                  owner === "provider" || owner === "shared-provider"
                    ? ([
                        {
                          cwd: owner === "shared-provider" ? cwd : nested,
                          status: "running",
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                owner === "shared-provider",
                            },
                          },
                        },
                      ] as never)
                    : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = ![
      "sibling",
      "shared-provider",
      "conversation",
      "offline-codespace",
      "different-codespace",
    ].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip, Effect.provide(workspaceLayer));
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.provide(workspaceLayer));
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lets rollback recreate a worktree storage cleanup removed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-removed-" });
    const worktreePath = path.join(parent, "worktree");
    const isolated = yield* isCheckpointRestoreIsolated(
      { id: ThreadId.make("restore-removed"), worktreePath },
      { cwd: worktreePath },
      {
        fileSystem,
        path,
        projections: {
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        projects: {} as never,
      },
    );
    assert.isTrue(isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { sideChat: "answering questions", running: false, toolItems: 0, isolated: true },
  { sideChat: "running", running: true, toolItems: 0, isolated: false },
  {
    sideChat: "running in a Codespace",
    running: true,
    toolItems: 0,
    isolated: false,
    remote: true,
  },
  { sideChat: "after running tools", running: false, toolItems: 1, isolated: false },
] as const)(
  "a side chat $sideChat shares the parent's worktree: $isolated",
  ({ running, toolItems, isolated, remote = false }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-v2-restore-side-chat-",
      });
      const worktreePath = remote ? path.join(parent, "remote-worktree") : parent;
      const parentId = ThreadId.make("restore-side-chat-parent");
      const sideChat = {
        id: ThreadId.make("restore-side-chat"),
        projectId: ProjectId.make("restore-project"),
        deletedAt: null,
        worktreePath,
        activeRunId: running ? "side-chat-run" : null,
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "fork",
          rootThreadId: parentId,
          sideChat: true,
        },
      };
      const result = yield* isCheckpointRestoreIsolated(
        { id: parentId, worktreePath },
        { cwd: worktreePath },
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [sideChat], archivedThreads: [] }),
            getThreadRecords: () =>
              Effect.succeed({
                turnItems: Array.from({ length: toolItems }, () => ({ type: "command_execution" })),
              }),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] }),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
          } as never,
          projects: {} as never,
        },
      ).pipe(
        Effect.provide(
          Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
            lookup: () => Effect.succeed(remote ? ({} as never) : null),
            call: (cwd) =>
              Effect.succeed({ path: cwd, type: "Directory", modifiedAt: null }) as never,
          }),
        ),
      );
      assert.equal(result, isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
