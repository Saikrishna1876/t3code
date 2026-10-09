import { CodespacesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { CodespacesWorkspace } from "./CodespacesWorkspace.ts";

export interface CodexWorkspaceExecutionParams {
  readonly environments?: ReadonlyArray<{
    readonly environmentId: string;
    readonly cwd: string;
    readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
  }>;
}

/** Local app-server authenticates inference; the registered executor receives only workspace operations. */
export function createCodexWorkspaceExecution<E>(
  workspace: CodespacesWorkspace["Service"] | undefined,
  request: (method: string, params: Record<string, unknown>) => Effect.Effect<unknown, E>,
): (
  cwd: string | null,
  nativeThreadId?: string,
) => Effect.Effect<CodexWorkspaceExecutionParams, CodespacesError> {
  const connections = new Map<string, string>();
  return (cwd: string | null, nativeThreadId?: string) =>
    Effect.gen(function* () {
      const target = cwd && workspace ? yield* workspace.lookup(cwd) : null;
      if (!target) {
        // Explicit reset also covers a resumed native thread that used a Codespace before controller restart.
        return nativeThreadId && workspace && cwd && (yield* workspace.wasRemote(cwd))
          ? { environments: [{ environmentId: "local", cwd }] }
          : {};
      }
      if (!target.executor || !target.remoteCwd)
        return yield* new CodespacesError({
          code: "conflict",
          message: "Resume this project's Codespace before starting the agent.",
        });
      const executor = target.executor;
      const environmentId = `codespace-${target.name}`;
      const generation = executor.execServerUrl + executor.token;
      if (connections.get(environmentId) !== generation) {
        yield* request("environment/add", {
          environmentId,
          execServerUrl: executor.execServerUrl,
          authBearerToken: executor.token,
          connectTimeoutMs: 20000,
        }).pipe(
          Effect.mapError(
            () =>
              new CodespacesError({
                code: "configuration",
                message:
                  "Codex could not connect its remote executor. Use Codex 0.160.1 or later and reconnect this project's Codespace.",
              }),
          ),
        );
        connections.set(environmentId, generation);
      }
      return {
        environments: [
          { environmentId, cwd: target.remoteCwd, runtimeWorkspaceRoots: [executor.remoteRoot] },
        ],
      };
    });
}
