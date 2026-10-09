import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Workspace from "./CodespacesWorkspace.ts";
import * as Preview from "./CodespacesPreview.ts";
import * as Project from "../orchestration-v2/ProjectStore.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
const threadId = ThreadId.make("preview-thread");
const projectId = ProjectId.make("project:mcp-test");
const project = Schema.decodeUnknownSync(Project.ProjectRow)({
  projectId,
  title: "Project",
  workspaceRoot: "/local/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
  deletedAt: null,
});
function layer(connected: boolean, ports: number[]) {
  return Preview.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Project.ProjectStoreV2)({ get: () => Effect.succeed(Option.some(project)) }),
        Layer.mock(Projection.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Workspace.CodespacesWorkspace)({
          lookup: () =>
            Effect.succeed({
              projectId,
              localRoot: "/local/repo",
              name: "space",
              remoteCwd: connected ? "/workspaces/repo" : null,
              executor: connected
                ? {
                    name: "space",
                    remoteRoot: "/workspaces/repo",
                    workerUrl: "http://localhost:1",
                    execServerUrl: "ws://localhost:2",
                    token: "executor-token",
                    forwardPort: (port) =>
                      Effect.sync(() => {
                        ports.push(port);
                        return 60000;
                      }),
                    isForwardedPort: (port) => port === 60000,
                  }
                : null,
            }),
        }),
      ),
    ),
  );
}
describe("Codespace preview forwarding", () => {
  it.effect("forwards loopback ports privately while preserving paths and external URLs", () =>
    Effect.gen(function* () {
      const ports: number[] = [];
      yield* Effect.gen(function* () {
        const preview = yield* Preview.CodespacesPreview;
        expect(yield* preview.resolve(threadId, "http://localhost:3000/page?x=1#anchor")).toBe(
          "http://127.0.0.1:60000/page?x=1#anchor",
        );
        expect(yield* preview.resolve(threadId, "http://127.0.0.1:60000/page")).toBe(
          "http://127.0.0.1:60000/page",
        );
        expect(yield* preview.resolve(threadId, "https://github.com")).toBe("https://github.com");
        expect(ports).toEqual([3000]);
      }).pipe(Effect.provide(layer(true, ports)));
    }),
  );
  it.effect("refuses local loopback fallback for a disconnected project", () =>
    Effect.gen(function* () {
      const preview = yield* Preview.CodespacesPreview;
      expect(
        (yield* preview.resolve(threadId, "http://localhost:3000").pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer(false, []))),
  );
});
