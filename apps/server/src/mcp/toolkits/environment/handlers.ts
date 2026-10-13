import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Codespaces from "../../../codespaces/Codespaces.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  codespaces_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const service = yield* Codespaces.Codespaces;
      return yield* service.list.pipe(Effect.mapError(unavailable));
    }),
  ),
  codespaces_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const service = yield* Codespaces.Codespaces;
      return { operations: (yield* service.snapshot).operations };
    }),
  ),
  codespaces_run: McpToolAccess.writesEnvironment(({ input }, check) =>
    Effect.gen(function* () {
      yield* check;
      const context = yield* access;
      const service = yield* Codespaces.Codespaces;
      if (!(yield* service.snapshot).configuration.agentAccessEnabled)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Enable Codespaces agent management in project settings before agents can manage billable workspaces.",
        });
      if (context.caller && input.projectId && input.projectId !== context.caller.projectId)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Manage Codespaces from their own project thread.",
        });
      const scopedInput = context.caller
        ? { ...input, projectId: context.caller.projectId }
        : input;
      return yield* service
        .run(scopedInput, context.caller?.projectId)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      // A thread caller serializes with its own turn; a client has no thread to lock.
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
