import { codespaceWorkspaceRoot, CommandId, EventId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

export const migrateThreadTargets = Effect.fn("Codespaces.migrateThreadTargets")(function* () {
  const service = yield* Effect.serviceOption(CodespacesWorkspace.CodespacesWorkspace);
  if (Option.isNone(service)) return;
  const workspaces = service.value;
  const legacy = (yield* workspaces.bindings).filter((binding) => !binding.hostRoot);
  if (legacy.length === 0) return;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const snapshots = yield* Effect.all([
    orchestrator.getShellSnapshot(),
    orchestrator.getShellSnapshot({ location: "archive" }),
  ]);
  for (const thread of new Map(
    snapshots
      .flatMap((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads])
      .map((thread) => [thread.id, thread]),
  ).values()) {
    const binding = legacy.find((candidate) => candidate.projectId === thread.projectId);
    if (thread.codespaceName === undefined)
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`codespace-target-v1:${thread.id}`),
        threadId: thread.id,
        codespaceName: binding?.name ?? null,
        ...(binding && thread.worktreePath !== null
          ? {
              worktreePath: CodespacesWorkspace.mapWorkspacePath(
                thread.worktreePath,
                binding.localRoot,
                codespaceWorkspaceRoot(binding.localRoot, binding.name),
              ),
            }
          : {}),
      });
    if (binding && (thread.codespaceName === undefined || thread.codespaceName === binding.name)) {
      const records = yield* orchestrator.getThreadRecords(thread.id, ["checkpointScopes"]);
      const root = codespaceWorkspaceRoot(binding.localRoot, binding.name);
      const events = records.checkpointScopes.flatMap((scope) => {
        const cwd = CodespacesWorkspace.isWorkspacePath(scope.cwd, root)
          ? scope.cwd
          : CodespacesWorkspace.mapWorkspacePath(scope.cwd, binding.localRoot, root);
        return cwd === scope.cwd
          ? []
          : [
              {
                id: EventId.make(`codespace-scope-v1:${scope.id}`),
                type: "checkpoint-scope.created" as const,
                threadId: thread.id,
                occurredAt: scope.createdAt,
                payload: { ...scope, cwd },
              },
            ];
      });
      if (events.length > 0) {
        const sink = yield* Effect.serviceOption(EventSink.EventSinkV2);
        if (Option.isNone(sink))
          return yield* Effect.die(new Error("Checkpoint migration requires the event sink."));
        yield* sink.value.write({ events });
      }
    }
  }
  // Pin all old threads before retiring project-wide routes; retries resume safely.
  for (const binding of legacy) {
    yield* workspaces.bind({
      ...binding,
      hostRoot: binding.localRoot,
      localRoot: codespaceWorkspaceRoot(binding.localRoot, binding.name),
    });
  }
});
