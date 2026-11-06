import {
  PreviewStopLocalServerError,
  threadWorkspaceRoot,
  type DiscoveredLocalServerList,
  type PreviewStopLocalServerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Workspace from "../codespaces/CodespacesWorkspace.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ProjectionStore.ts";
import * as PortScanner from "./PortScanner.ts";

export class WorkspaceDiscovery extends Context.Service<
  WorkspaceDiscovery,
  {
    readonly stream: (input: {
      readonly threadId?: ThreadId;
      readonly configuredUrls?: ReadonlyArray<string> | undefined;
    }) => Stream.Stream<DiscoveredLocalServerList>;
    readonly stop: (
      input: PreviewStopLocalServerInput,
    ) => Effect.Effect<void, PreviewStopLocalServerError>;
  }
>()("t3/preview/WorkspaceDiscovery") {}

const make = Effect.gen(function* () {
  const workspace = yield* Workspace.CodespacesWorkspace;
  const projects = yield* Projects.ProjectStoreV2;
  const threads = yield* Threads.ProjectionStoreV2;
  const local = yield* PortScanner.PortDiscovery;
  const target = Effect.fn("WorkspaceDiscovery.target")(function* (threadId?: ThreadId) {
    if (!threadId) return null;
    const thread = yield* threads.getThreadShell(threadId);
    if (!thread) return yield* new PreviewStopLocalServerError({ reason: "not-found" });
    if (!thread.codespaceName) return null;
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project))
      return yield* new PreviewStopLocalServerError({ reason: "not-found" });
    return {
      name: thread.codespaceName,
      cwd: thread.worktreePath ?? threadWorkspaceRoot(thread, project.value.workspaceRoot),
    };
  });
  const stream: WorkspaceDiscovery["Service"]["stream"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const location = yield* target(input.threadId);
        if (!location)
          return Stream.callback<DiscoveredLocalServerList>((queue) =>
            Effect.gen(function* () {
              const configuredUrls = input.configuredUrls ?? [];
              yield* local.retain;
              const initial = yield* local.scan(configuredUrls);
              yield* Queue.offer(queue, {
                servers: initial,
                scannedAt: DateTime.formatIso(yield* DateTime.now),
                configuredUrlProbing: true,
              });
              yield* local.subscribe({ configuredUrls, initialSnapshot: initial }, (servers) =>
                Effect.gen(function* () {
                  yield* Queue.offer(queue, {
                    servers,
                    scannedAt: DateTime.formatIso(yield* DateTime.now),
                    configuredUrlProbing: true,
                  });
                }),
              );
            }),
          );
        const sample = Effect.fn("WorkspaceDiscovery.sample")(function* () {
          const scannedAt = DateTime.formatIso(yield* DateTime.now);
          return yield* workspace
            .call<Omit<DiscoveredLocalServerList, "scannedAt">>(location.cwd, "telemetry", "scan", [
              { cwd: location.cwd, threadId: input.threadId },
            ])
            .pipe(
              Effect.map((snapshot) => ({
                ...snapshot,
                codespaceName: location.name,
                scannedAt,
              })),
              Effect.orElseSucceed(() => ({
                servers: [],
                codespaceName: location.name,
                scannedAt,
                error: "disconnected" as const,
              })),
            );
        });
        return Stream.fromEffectSchedule(sample(), Schedule.spaced("3 seconds"));
      }).pipe(
        Effect.orElseSucceed(() =>
          Stream.fromEffect(
            DateTime.now.pipe(
              Effect.map((now) => ({
                servers: [],
                scannedAt: DateTime.formatIso(now),
                error: "disconnected" as const,
              })),
            ),
          ),
        ),
      ),
    );
  const stop = Effect.fn("WorkspaceDiscovery.stop")(function* (input: PreviewStopLocalServerInput) {
    const location = yield* target(input.threadId).pipe(
      Effect.mapError(() => new PreviewStopLocalServerError({ reason: "not-found" })),
    );
    if (!location) return yield* local.stopServer(input);
    yield* workspace
      .call<void>(location.cwd, "telemetry", "stop", [{ ...input, cwd: location.cwd }])
      .pipe(Effect.mapError(() => new PreviewStopLocalServerError({ reason: "not-found" })));
  });
  return WorkspaceDiscovery.of({ stream, stop });
});

export const layer = Layer.effect(WorkspaceDiscovery, make);
