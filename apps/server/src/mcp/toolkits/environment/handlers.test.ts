import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as Codespaces from "../../../codespaces/Codespaces.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect(
  "exposes object parameters and requires explicit agent opt-in for Codespaces writes",
  () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(false);
      const runs = yield* Ref.make(0);
      const input = {
        action: "stop" as const,
        name: "test-space",
        clientRequestId: "stop-request-1",
      };
      const dependencies = Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:codespaces",
          thread: {
            threadId,
            providerSessionId: "provider:codespaces",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false, codespaces: true },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({}),
        Layer.mock(Codespaces.Codespaces)({
          snapshot: Ref.get(enabled).pipe(
            Effect.map((agentAccessEnabled) => ({
              configuration: {
                releaseBaseUrl: "",
                archiveVersion: "",
                remoteScriptPath: "",
                publicUrlTemplate: "",
                networkAccess: false,
                agentAccessEnabled,
              },
              operations: [],
              environments: [],
            })),
          ),
          run: () =>
            Ref.update(runs, (value) => value + 1).pipe(
              Effect.as({
                ...input,
                status: "running" as const,
                stage: "accepted",
                message: "Accepted",
                createdAt: "2026-10-08T00:00:00Z",
              }),
            ),
        }),
      );
      // The MCP registrar rejects a union at the root of tool parameters.
      expect(Tool.getJsonSchema(EnvironmentToolkit.tools.codespaces_run).type).toBe("object");
      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const denied = yield* toolkit
          .handle("codespaces_run", { input })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        expect(yield* Ref.get(runs)).toBe(0);
        yield* Ref.set(enabled, true);
        const accepted = yield* toolkit
          .handle("codespaces_run", { input })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(accepted.at(-1)?.result).toMatchObject({ action: "stop", status: "running" });
        expect(yield* Ref.get(runs)).toBe(1);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
            Layer.provideMerge(dependencies),
          ),
        ),
      );
    }),
);

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    // Completes once the declaration's own check has read the caller.
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.mock(Codespaces.Codespaces)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // A turn-completion command holds the thread's lock.
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      // The update passed its first check and waits for the lock; the turn then ends.
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
