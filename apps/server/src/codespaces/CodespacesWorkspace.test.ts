import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Workspace from "./CodespacesWorkspace.ts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

function fixture(httpClient = FetchHttpClient.layer) {
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
    Layer.provide(httpClient),
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
  it.effect.each(["C:\\Repo\\", "\\\\host\\share\\Repo\\"])(
    "routes Windows children of %s remotely and refuses disconnected work",
    (root) =>
      Effect.gen(function* () {
        const service = yield* Workspace.CodespacesWorkspace;
        yield* service.bind({ projectId: "windows", localRoot: root, name: "space" });
        yield* service.register({
          name: "space",
          remoteRoot: "/workspaces/project",
          workerUrl: "http://localhost:1",
          execServerUrl: "ws://localhost:2",
          token: "private",
        });
        const child = root.toLowerCase() + "src\\nested";
        expect((yield* service.lookup(child))?.remoteCwd).toBe("/workspaces/project/src/nested");
        expect((yield* service.lookup(child.replaceAll("\\", "/")))?.remoteCwd).toBe(
          "/workspaces/project/src/nested",
        );
        expect((yield* service.lookup(root))?.remoteCwd).toBe("/workspaces/project");
        expect(yield* service.lookup(root.slice(0, -1) + "-other\\src")).toBeNull();
        expect(yield* service.lookup(root + "..\\other")).toBeNull();
        yield* service.disconnect("space");
        expect((yield* service.lookup(child))?.executor).toBeNull();
        let localCalls = 0;
        const port = Workspace.routeWorkspaceMethods(
          { read: (_cwd: string) => Effect.sync(() => localCalls++) },
          service,
          "files",
          (cause) => cause,
        );
        expect(yield* port.read(child).pipe(Effect.flip)).toMatchObject({ code: "conflict" });
        expect(localCalls).toBe(0);
        expect(yield* service.wasRemote(child)).toBe(true);
        yield* service.bind({ projectId: "windows", name: null });
        expect(yield* service.wasRemote(child)).toBe(true);
        expect(yield* service.wasRemote(root.slice(0, -1) + "-other")).toBe(false);
        yield* port.read(child);
        expect(localCalls).toBe(1);
      }).pipe(Effect.provide(fixture())),
  );

  it.effect("sends POSIX arguments from Windows and returns host worktree paths", () => {
    const requests: unknown[] = [];
    const layer = fixture(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag === "Uint8Array")
            requests.push(JSON.parse(new TextDecoder().decode(request.body.body)));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ value: { worktreePath: "/workspaces/project/tree" } })),
            ),
          );
        }),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* Workspace.CodespacesWorkspace;
      yield* service.bind({ projectId: "windows", localRoot: "C:\\Repo", name: "space" });
      yield* service.register({
        name: "space",
        remoteRoot: "/workspaces/project",
        workerUrl: "http://localhost:1",
        execServerUrl: "ws://localhost:2",
        token: "private",
      });
      const port = Workspace.routeWorkspaceMethods(
        { createWorktree: (_input: { cwd: string; worktreePath: string }) => Effect.die("Local") },
        service,
        "git",
        (cause) => cause,
      );
      const result = yield* port.createWorktree({
        cwd: "c:\\repo\\src",
        worktreePath: "C:/Repo/tree",
      });
      expect(result).toEqual({ worktreePath: "C:\\Repo\\tree" });
      expect(requests).toEqual([
        {
          group: "git",
          method: "createWorktree",
          args: [{ cwd: "/workspaces/project/src", worktreePath: "/workspaces/project/tree" }],
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it("maps Windows paths in both directions without changing opaque text or POSIX case", () => {
    expect(
      Workspace.mapWorkspacePaths(
        {
          cwd: "c:/repo/src",
          filePaths: ["C:\\REPO\\src\\file.ts", "C:\\Repo-other\\file.ts"],
          message: "C:\\Repo\\keep",
        },
        "C:\\Repo",
        "/workspaces/project",
      ),
    ).toEqual({
      cwd: "/workspaces/project/src",
      filePaths: ["/workspaces/project/src/file.ts", "C:\\Repo-other\\file.ts"],
      message: "C:\\Repo\\keep",
    });
    expect(
      Workspace.mapWorkspacePaths(
        { path: "/workspaces/project/src/file.ts", cwd: "/workspaces/Project" },
        "/workspaces/project/",
        "C:\\Repo",
      ),
    ).toEqual({ path: "C:\\Repo\\src\\file.ts", cwd: "/workspaces/Project" });
  });

  it.effect("bounds asset requests when the worker never sends headers", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const layer = fixture(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
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
        const pending = yield* service
          .openAsset({
            cwd: "/local/project",
            relativePath: "index.html",
            name: "space",
            offset: 0,
            size: 100,
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(requested);
        yield* TestClock.adjust("30 seconds");
        expect((yield* Fiber.join(pending)).code).toBe("bootstrap");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
  it.effect("reserves shared projects and both targets until lifecycle cleanup", () =>
    Effect.gen(function* () {
      const service = yield* Workspace.CodespacesWorkspace;
      yield* service.bind({ projectId: "one", localRoot: "/local/one", name: "shared" });
      yield* service.bind({ projectId: "two", localRoot: "/local/two", name: "shared" });
      const operationScope = yield* Scope.make();
      yield* service
        .reserve({ id: "switch", projectId: "one", name: "next" })
        .pipe(Effect.provideService(Scope.Scope, operationScope));
      for (const projectId of ["one", "two"]) {
        expect((yield* service.acquireWork(projectId).pipe(Effect.scoped, Effect.flip)).code).toBe(
          "busy",
        );
        expect((yield* service.bind({ projectId, name: null }).pipe(Effect.flip)).code).toBe(
          "busy",
        );
      }
      expect(
        (yield* service
          .bind({ projectId: "third", localRoot: "/local/three", name: "next" })
          .pipe(Effect.flip)).code,
      ).toBe("busy");
      expect(
        (yield* service
          .reserve({ id: "other", projectId: "one", name: "different" })
          .pipe(Effect.scoped, Effect.flip)).code,
      ).toBe("busy");
      yield* service.bind({ projectId: "one", localRoot: "/local/one", name: "next" }, "switch");
      yield* Scope.close(operationScope, Exit.void);
      yield* service.acquireWork("one").pipe(Effect.scoped);
      yield* service.acquireWork("two").pipe(Effect.scoped);
      yield* service.bind({ projectId: "one", name: null });
    }).pipe(Effect.provide(fixture())),
  );

  it.effect("cannot reserve a project while provider startup holds it", () =>
    Effect.gen(function* () {
      const service = yield* Workspace.CodespacesWorkspace;
      const workScope = yield* Scope.make();
      yield* service.acquireWork("one").pipe(Effect.provideService(Scope.Scope, workScope));
      expect(
        (yield* service.reserve({ id: "stop", projectId: "one" }).pipe(Effect.scoped, Effect.flip))
          .code,
      ).toBe("busy");
      yield* Scope.close(workScope, Exit.void);
      yield* service.reserve({ id: "stop", projectId: "one" }).pipe(Effect.scoped);
    }).pipe(Effect.provide(fixture())),
  );
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
