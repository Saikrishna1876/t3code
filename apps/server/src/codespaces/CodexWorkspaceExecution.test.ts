import { CodespacesError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Workspace from "./CodespacesWorkspace.ts";
import { createCodexWorkspaceExecution } from "./CodexWorkspaceExecution.ts";

const executor: Workspace.WorkspaceExecutor = {
  name: "space",
  remoteRoot: "/workspaces/repo",
  workerUrl: "http://localhost:1",
  execServerUrl: "ws://localhost:2",
  token: "executor-only-token",
};

describe("local Codex with remote executor", () => {
  it.effect("registers each connection generation once and sends only remote execution roots", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.CodespacesWorkspace;
      const requests: Record<string, unknown>[] = [];
      const resolve = createCodexWorkspaceExecution(workspace, (_method, input) =>
        Effect.sync(() => {
          requests.push(input);
        }),
      );
      expect(yield* resolve("/local/repo", "resumed-thread")).toEqual({
        environments: [
          {
            environmentId: "codespace-space",
            cwd: "/workspaces/repo",
            runtimeWorkspaceRoots: ["/workspaces/repo"],
          },
        ],
      });
      yield* resolve("/local/repo/src");
      expect(requests).toEqual([
        {
          environmentId: "codespace-space",
          execServerUrl: executor.execServerUrl,
          authBearerToken: executor.token,
          connectTimeoutMs: 20000,
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(Workspace.CodespacesWorkspace)({
          lookup: (cwd) =>
            Effect.succeed({
              projectId: "project",
              localRoot: "/local/repo",
              name: "space",
              executor,
              remoteCwd: "/workspaces/repo" + cwd.slice("/local/repo".length),
            }),
        }),
      ),
    ),
  );

  it.effect(
    "fails before inference when disconnected or executor registration is unsupported",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.CodespacesWorkspace;
        let requests = 0;
        const resolve = createCodexWorkspaceExecution(workspace, () => {
          requests++;
          return Effect.fail(
            new CodespacesError({ code: "configuration", message: "Method not found" }),
          );
        });
        const result = yield* resolve("/local/repo").pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(requests).toBe(1);
        const offline = {
          ...workspace,
          lookup: () =>
            Effect.succeed({
              projectId: "project",
              localRoot: "/local/repo",
              name: "space",
              executor: null,
              remoteCwd: null,
            }),
        };
        expect(
          (yield* createCodexWorkspaceExecution(offline, () =>
            Effect.die("Must not request inference"),
          )("/local/repo").pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(
        Effect.provide(
          Layer.mock(Workspace.CodespacesWorkspace)({
            lookup: () =>
              Effect.succeed({
                projectId: "project",
                localRoot: "/local/repo",
                name: "space",
                executor,
                remoteCwd: "/workspaces/repo",
              }),
          }),
        ),
      ),
  );

  it.effect("resets resumed threads to local execution even after a controller restart", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.CodespacesWorkspace;
      expect(
        yield* createCodexWorkspaceExecution(workspace, () => Effect.die("No remote registration"))(
          "/local/repo",
          "previously-remote",
        ),
      ).toEqual({ environments: [{ environmentId: "local", cwd: "/local/repo" }] });
    }).pipe(
      Effect.provide(
        Layer.mock(Workspace.CodespacesWorkspace)({
          lookup: () => Effect.succeed(null),
          wasRemote: () => Effect.succeed(true),
        }),
      ),
    ),
  );
});

it.effect("preserves native local requests for projects that never used a Codespace", () =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.CodespacesWorkspace;
    expect(
      yield* createCodexWorkspaceExecution(workspace, () => Effect.die("No remote calls"))(
        "/local/untouched",
        "existing-local-thread",
      ),
    ).toEqual({});
  }).pipe(
    Effect.provide(
      Layer.mock(Workspace.CodespacesWorkspace)({
        lookup: () => Effect.succeed(null),
        wasRemote: () => Effect.succeed(false),
      }),
    ),
  ),
);
