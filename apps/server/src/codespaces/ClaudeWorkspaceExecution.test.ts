import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import { claudeWorkspaceExecution } from "./ClaudeWorkspaceExecution.ts";

it.effect("keeps unbound Claude work local without requiring Codespaces", () =>
  Effect.gen(function* () {
    expect(yield* claudeWorkspaceExecution(undefined, "/project", false)).toBeUndefined();
    const workspace = yield* CodespacesWorkspace.CodespacesWorkspace;
    expect(yield* claudeWorkspaceExecution(workspace, "/project", false)).toBeUndefined();
  }).pipe(
    Effect.provide(
      Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({ lookup: () => Effect.succeed(null) }),
    ),
  ),
);

it.effect("fails closed when a bound Claude workspace disconnects", () =>
  Effect.gen(function* () {
    const workspace = yield* CodespacesWorkspace.CodespacesWorkspace;
    const failure = yield* claudeWorkspaceExecution(workspace, "/project", false).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "CodespacesError", code: "conflict" });
  }).pipe(
    Effect.provide(
      Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
        lookup: () =>
          Effect.succeed({
            projectId: "project",
            name: "space",
            localRoot: "/project",
            executor: null,
            remoteCwd: null,
          }),
      }),
    ),
  ),
);

it.effect("separates read-only remote tools from writable execution", () =>
  Effect.gen(function* () {
    const workspace = yield* CodespacesWorkspace.CodespacesWorkspace;
    const writable = yield* claudeWorkspaceExecution(workspace, "/project", false);
    const readOnly = yield* claudeWorkspaceExecution(workspace, "/project", true);
    expect(writable?.toolAliases.Bash).toBe("mcp__t3-workspace__Bash");
    expect(readOnly?.toolAliases).not.toHaveProperty("Bash");
    expect(readOnly?.mcpServers["t3-workspace"].url).toMatch(/\/read-only$/);
    expect(JSON.stringify(readOnly?.mcpServers)).not.toBe(JSON.stringify(writable?.mcpServers));
    expect(writable?.tools).not.toContain("Bash");
    expect(writable?.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Read", "Write", "Edit", "Agent", "Skill", "LSP"]),
    );
  }).pipe(
    Effect.provide(
      Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
        lookup: () =>
          Effect.succeed({
            projectId: "project",
            name: "space",
            localRoot: "/project",
            remoteCwd: "/workspaces/project",
            executor: {
              name: "space",
              remoteRoot: "/workspaces/project",
              workerUrl: "http://localhost:1",
              execServerUrl: "ws://localhost:2",
              token: "fixture",
            },
          }),
      }),
    ),
  ),
);
