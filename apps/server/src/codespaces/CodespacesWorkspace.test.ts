import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Workspace from "./CodespacesWorkspace.ts";

function fixture() {
  const stored = new Map<string, Uint8Array>();
  const layer = Workspace.layer.pipe(
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(stored.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            stored.set(key, value);
          }),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          realPath: (path) => Effect.succeed(path.replace(/^\/tmp\//, "/private/tmp/")),
        }),
      ),
    ),
  );
  return layer;
}

describe("project workspace binding", () => {
  it.effect("persists target but never persists a live executor", () => {
    const layer = fixture();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* Workspace.CodespacesWorkspace;
        yield* service.bind({ projectId: "one", localRoot: "/local/project", name: "space" });
        yield* service.register({
          name: "space",
          remoteRoot: "/workspaces/project",
          workerUrl: "http://localhost:1",
          execServerUrl: "ws://localhost:2",
          token: "private",
        });
        expect((yield* service.lookup("/local/project/src"))?.remoteCwd).toBe(
          "/workspaces/project/src",
        );
        expect(yield* service.lookup("/local/project-other")).toBeNull();
      }).pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const service = yield* Workspace.CodespacesWorkspace;
        expect((yield* service.lookup("/local/project"))?.executor).toBeNull();
        expect((yield* service.bindings)[0]?.name).toBe("space");
        expect(yield* service.wasRemote("/local/project")).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });

  it.effect("refuses disconnected operations without touching local files", () =>
    Effect.gen(function* () {
      const service = yield* Workspace.CodespacesWorkspace;
      yield* service.bind({ projectId: "one", localRoot: "/local/project", name: "space" });
      let localCalls = 0;
      const port = Workspace.routeWorkspaceMethods(
        {
          write: (_input: { cwd: string; contents: string }) =>
            Effect.sync(() => {
              localCalls++;
            }),
        },
        service,
        "files",
        (cause) => cause,
      );
      const result = yield* port
        .write({ cwd: "/local/project", contents: "remote" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(localCalls).toBe(0);
      yield* service.bind({ projectId: "one", name: null });
      expect(yield* service.wasRemote("/local/project")).toBe(true);
      yield* port.write({ cwd: "/local/project", contents: "local" });
      expect(localCalls).toBe(1);
    }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "keeps canonical Git paths bound to the remote workspace, including after disconnect",
    () =>
      Effect.gen(function* () {
        const service = yield* Workspace.CodespacesWorkspace;
        yield* service.bind({ projectId: "one", localRoot: "/tmp/project", name: "space" });
        yield* service.register({
          name: "space",
          remoteRoot: "/workspaces/project",
          workerUrl: "http://localhost:1",
          execServerUrl: "ws://localhost:2",
          token: "private",
        });
        const target = yield* service.lookup("/private/tmp/project/src");
        expect(target?.remoteCwd).toBe("/workspaces/project/src");
        expect(target?.localRoot).toBe("/private/tmp/project");
        expect(yield* service.lookup("/private/tmp/project-other")).toBeNull();
        yield* service.disconnect("space");
        expect((yield* service.lookup("/private/tmp/project"))?.executor).toBeNull();
        expect(yield* service.wasRemote("/private/tmp/project/src")).toBe(true);
        yield* service.bind({ projectId: "one", name: null });
        expect(yield* service.wasRemote("/private/tmp/project/src")).toBe(true);
      }).pipe(Effect.provide(fixture())),
  );

  it("maps workspace paths while preserving opaque file contents and Git messages", () => {
    expect(
      Workspace.mapWorkspacePaths(
        [
          {
            cwd: "/local/project",
            contents: "/local/project/leave-this",
            message: "/local/project/leave-this",
            worktreePath: "/local/project/sub",
          },
        ],
        "/local/project",
        "/workspaces/project",
      ),
    ).toEqual([
      {
        cwd: "/workspaces/project",
        contents: "/local/project/leave-this",
        message: "/local/project/leave-this",
        worktreePath: "/workspaces/project/sub",
      },
    ]);
  });
});
