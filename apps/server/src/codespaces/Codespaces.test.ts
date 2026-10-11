import { makeWorkspaceReservations } from "./WorkspaceReservations.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  CodespacesError,
  type CodespacesConfiguration,
  type CodespacesOperation,
  CodespacesRunInput,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as Codespaces from "./Codespaces.ts";
import * as CodespacesHost from "./CodespacesHost.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import * as FileSystem from "effect/FileSystem";
import { ProjectId } from "@t3tools/contracts";

const configuration: CodespacesConfiguration = {
  releaseBaseUrl: "https://github.com/example/fork/releases/download",
  archiveVersion: "0.0.46",
  remoteScriptPath: "",
  publicUrlTemplate: "https://{name}.example.com",
  networkAccess: false,
  agentAccessEnabled: false,
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const requestKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ account: Schema.String, input: CodespacesRunInput })),
);
const raw = (id = 1, state = "Available") => ({
  id,
  name: `test-space-${id}`,
  display_name: `Test ${id}`,
  repository: { full_name: "example/fork" },
  git_status: { ref: "main" },
  state,
  machine: { name: "standardLinux32gb" },
  web_url: "https://github.com/codespaces",
  idle_timeout_minutes: 30,
  retention_period_minutes: 1440,
});
const managed = {
  name: "test-space-1",
  account: "example",
  codespaceId: 1,
  environmentId: EnvironmentId.make("codespace-env"),
  localPort: 12345,
  remotePort: 3773,
  workspacePath: "/workspaces/fork",
  connected: true,
};
const testProjectId = ProjectId.make("project-test");
const create: CodespacesRunInput = {
  action: "create",
  clientRequestId: "create-request-1",
  repository: "example/fork",
  projectId: ProjectId.make("project-test"),
  ref: "main",
  devcontainerPath: ".devcontainer/devcontainer.json",
  machine: "standardLinux32gb",
  idleTimeoutMinutes: 30,
  retentionDays: 1,
};

function harness(
  overrides: {
    rest?: GitHubApi.GitHubApi["Service"]["rest"];
    connect?: CodespacesHost.CodespacesHost["Service"]["connect"];
    prepareStop?: CodespacesHost.CodespacesHost["Service"]["prepareStop"];
    saved?: Uint8Array;
    devcontainerEntries?: string[];
    bindings?: ReadonlyArray<CodespacesWorkspace.WorkspaceBinding>;
    threads?: ReadonlyArray<
      Pick<
        OrchestrationV2ThreadShell,
        "id" | "projectId" | "status" | "activityRunStatus" | "pendingRuntimeRequest"
      >
    >;
  } = {},
) {
  const reservations = makeWorkspaceReservations();
  const bindings = overrides.bindings ?? [
    { projectId: "project-test", localRoot: "/workspace/fork", name: "test-space-1" },
  ];
  const requests: GitHubApi.GitHubRestInput[] = [];
  const targetEvents: string[] = [];
  const pinnedTokens: string[] = [];
  let account = "example";
  let token = "first-token";
  let state = "Available";
  let connects = 0;
  let disconnects = 0;
  let rebuilds = 0;
  let threads = overrides.threads ?? [];
  const stored = new Map<string, Uint8Array>(
    overrides.saved ? [["codespaces-controller-v1", overrides.saved]] : [],
  );
  const rest: GitHubApi.GitHubApi["Service"]["rest"] = (input) =>
    Effect.gen(function* () {
      requests.push(input);
      const credential = yield* GitHubApi.PinnedGitHubCredential;
      if (credential) pinnedTokens.push(Redacted.value(credential.token));
      if (input.path.includes("/machines"))
        return {
          status: 200,
          headers: {},
          body: json({
            machines: [
              {
                name: "standardLinux32gb",
                display_name: "4 cores",
                cpus: 4,
                memory_in_bytes: 32000000,
              },
            ],
          }),
          truncated: false,
          invalidUtf8: false,
        };
      if (input.path.includes("/devcontainers"))
        return {
          status: 200,
          headers: {},
          body: json({ devcontainers: [{ path: ".devcontainer/devcontainer.json" }] }),
          truncated: false,
          invalidUtf8: false,
        };
      if (overrides.rest) return yield* overrides.rest(input);
      if (input.path.endsWith("/stop")) state = "Shutdown";
      const body =
        input.path === "user"
          ? { login: account }
          : input.path.startsWith("user/codespaces?")
            ? { codespaces: [raw(1, state)] }
            : input.path === "repos/example/fork"
              ? { id: 42 }
              : raw(1, state);
      return { status: 200, headers: {}, body: json(body), truncated: false, invalidUtf8: false };
    });
  const layer = Codespaces.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (path) =>
              path.includes(".sh/devcontainer.json")
                ? Effect.die("Tried to inspect a configuration inside a file")
                : Effect.succeed(
                    path === "/workspace/fork/.devcontainer" ||
                      path === "/workspace/fork/.devcontainer/devcontainer.json" ||
                      path === "/workspace/fork/.devcontainer/fork-update/devcontainer.json",
                  ),
            readDirectory: () => Effect.succeed(overrides.devcontainerEntries ?? []),
            stat: (path) =>
              Effect.succeed({
                type: path.endsWith(".sh") ? "File" : "Directory",
              } as FileSystem.File.Info),
          }),
        ),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace/fork" })),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getShellSnapshot: () => Effect.sync(() => ({ threads })),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
        Layer.succeed(VcsProcess.VcsProcess, {
          run: (input) =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: input.args.includes("origin")
                ? "https://github.com/example/fork.git"
                : "main",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
        Layer.succeed(CodespacesWorkspace.CodespacesWorkspace, {
          wasRemote: () => Effect.succeed(false),
          bindings: Effect.succeed(bindings),
          acquireWork: reservations.acquireWork,
          reserve: ({ id, projectId, name, extend }) => {
            const names = new Set(name ? [name] : []);
            for (const binding of bindings)
              if (binding.projectId === projectId) names.add(binding.name);
            const projects = new Set(projectId ? [projectId] : []);
            for (const binding of bindings)
              if (names.has(binding.name)) projects.add(binding.projectId);
            return reservations
              .reserve(id, [...projects], [...names], extend)
              .pipe(Effect.as([...projects]));
          },
          bind: (binding) =>
            Effect.sync(() => {
              targetEvents.push("bind:" + binding.name);
            }),
          lookup: () => Effect.succeed(null),
          disconnect: () => Effect.void,
          register: () => Effect.void,
          stageAttachment: () => Effect.die("Unexpected attachment staging"),
          openAsset: () => Effect.die("Unexpected asset streaming"),
          call: () => Effect.die("Unexpected worker request"),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          close: ({ threadId }) =>
            Effect.sync(() => {
              targetEvents.push("close:" + threadId);
            }),
        }),
        Layer.succeed(GitHubApi.GitHubApi, {
          rest,
          credential: () => Effect.succeed({ token: Redacted.make(token), fingerprint: token }),
          graphql: () => Effect.die("Unexpected GraphQL"),
        }),
        Layer.succeed(GitHubCredentials.GitHubCredentials, {
          get: () =>
            Effect.sync(() => ({
              host: "github.com",
              token: Redacted.make(token),
              source: "gh" as const,
              fingerprint: token,
            })),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: (key) => Effect.sync(() => Option.fromUndefinedOr(stored.get(key))),
          set: (key, bytes) =>
            Effect.sync(() => {
              stored.set(key, bytes);
            }),
          create: () => Effect.die("Unexpected create"),
          getOrCreateRandom: () => Effect.die("Unexpected random secret"),
          remove: (key) =>
            Effect.sync(() => {
              stored.delete(key);
            }),
        }),
        Layer.succeed(CodespacesHost.CodespacesHost, {
          connect: (...args) =>
            Effect.sync(() => {
              connects++;
            }).pipe(
              Effect.andThen(
                overrides.connect ? overrides.connect(...args) : Effect.succeed(managed),
              ),
            ),
          prepareStop: overrides.prepareStop ?? (() => Effect.void),
          disconnect: () =>
            Effect.sync(() => {
              disconnects++;
            }),
          rebuild: () =>
            Effect.sync(() => {
              rebuilds++;
            }),
          pair: () =>
            Effect.succeed({
              environmentId: managed.environmentId,
              label: "test",
              httpBaseUrl: "http://127.0.0.1:12345",
              pairingCode: "one-time-code",
              workspacePath: managed.workspacePath,
            }),
          disconnected: Stream.empty,
        }),
      ),
    ),
  );
  return {
    layer,
    acquireWork: reservations.acquireWork,
    requests,
    pinnedTokens,
    targetEvents,
    connects: () => connects,
    disconnects: () => disconnects,
    rebuilds: () => rebuilds,
    threads: (value: typeof threads) => {
      threads = value;
    },
    saved: () => stored.get("codespaces-controller-v1")!,
    account: (value: string) => {
      account = value;
      token = "second-token";
    },
  };
}
const completed = (service: Codespaces.Codespaces["Service"], id: string) =>
  service.changes.pipe(
    Stream.map((snapshot) =>
      snapshot.operations.find((operation) => operation.clientRequestId === id),
    ),
    Stream.filter(
      (operation): operation is CodespacesOperation =>
        operation !== undefined && operation.status !== "running",
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("Codespaces controller", () => {
  it.effect("completed connect retries bypass new-operation checks while work is active", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      const input = {
        action: "connect" as const,
        projectId: testProjectId,
        name: managed.name,
        clientRequestId: "completed-connect",
      };
      yield* service.run(input);
      const finished = yield* completed(service, input.clientRequestId);
      expect(finished.status).toBe("succeeded");
      test.threads([
        {
          id: ThreadId.make("now-busy"),
          projectId: testProjectId,
          status: "running",
          activityRunStatus: "running",
          pendingRuntimeRequest: null,
        },
      ]);
      const requestCount = test.requests.length;
      expect(yield* service.run(input)).toEqual(finished);
      expect(test.requests.slice(requestCount).every((request) => request.path === "user")).toBe(
        true,
      );
      expect(test.connects()).toBe(1);
      expect((yield* service.run({ ...input, name: "other-space" }).pipe(Effect.flip)).code).toBe(
        "conflict",
      );
      test.account("other-account");
      expect((yield* service.run(input).pipe(Effect.flip)).code).toBe("conflict");
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("failed reconnect clears the controller's previous connected status", () => {
    let fail = false;
    const test = harness({
      connect: () =>
        fail
          ? Effect.fail(new CodespacesError({ code: "bootstrap", message: "replacement failed" }))
          : Effect.succeed(managed),
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.run({
        action: "connect",
        projectId: testProjectId,
        name: managed.name,
        clientRequestId: "first-connect",
      });
      yield* completed(service, "first-connect");
      expect((yield* service.snapshot).environments[0]?.connected).toBe(true);
      fail = true;
      yield* service.run({
        action: "connect",
        projectId: testProjectId,
        name: managed.name,
        clientRequestId: "replacement-connect",
      });
      expect((yield* completed(service, "replacement-connect")).status).toBe("failed");
      expect((yield* service.snapshot).environments[0]?.connected).toBe(false);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("reconnect refuses to restart a workspace used by another project", () => {
    const test = harness({
      bindings: [
        { projectId: "project-test", localRoot: "/workspace/fork", name: managed.name },
        { projectId: "other-project", localRoot: "/workspace/other", name: managed.name },
      ],
      threads: [
        {
          id: ThreadId.make("busy-other"),
          projectId: ProjectId.make("other-project"),
          status: "running",
          activityRunStatus: "running",
          pendingRuntimeRequest: null,
        },
      ],
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      const denied = yield* service
        .run({
          action: "connect",
          projectId: testProjectId,
          name: managed.name,
          clientRequestId: "shared-connect",
        })
        .pipe(Effect.flip);
      expect(denied.code).toBe("conflict");
      expect(test.connects()).toBe(0);
      expect(test.targetEvents).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("lifecycle excludes new work and binding changes through remote waits", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = harness({
        connect: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(managed),
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        yield* service.run({
          action: "connect",
          projectId: testProjectId,
          name: managed.name,
          clientRequestId: "reserved-connect",
        });
        yield* Deferred.await(entered);
        expect((yield* test.acquireWork(testProjectId).pipe(Effect.scoped, Effect.flip)).code).toBe(
          "busy",
        );
        expect(
          (yield* service.bind({ projectId: testProjectId, name: null }).pipe(Effect.flip)).code,
        ).toBe("busy");
        expect(
          (yield* service.run({ ...create, clientRequestId: "competing-create" }).pipe(Effect.flip))
            .code,
        ).toBe("busy");
        yield* Deferred.succeed(release, undefined);
        yield* completed(service, "reserved-connect");
        yield* test.acquireWork(testProjectId).pipe(Effect.scoped);
        yield* service.bind({ projectId: testProjectId, name: null });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("failed lifecycle releases project and target reservations", () => {
    const test = harness({
      connect: () =>
        Effect.fail(new CodespacesError({ code: "bootstrap", message: "fixture failure" })),
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.run({
        action: "connect",
        projectId: testProjectId,
        name: managed.name,
        clientRequestId: "failed-connect",
      });
      expect((yield* completed(service, "failed-connect")).status).toBe("failed");
      yield* service.run({
        action: "connect",
        projectId: testProjectId,
        name: managed.name,
        clientRequestId: "retry-connect",
      });
      expect((yield* completed(service, "retry-connect")).status).toBe("failed");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("loads account and inventory concurrently on first open", () =>
    Effect.gen(function* () {
      const accountStarted = yield* Deferred.make<void>();
      const inventoryStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = harness({
        rest: (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(
              input.path === "user" ? accountStarted : inventoryStarted,
              undefined,
            );
            yield* Deferred.await(release);
            return {
              status: 200,
              headers: {},
              body: json(input.path === "user" ? { login: "example" } : { codespaces: [] }),
              truncated: false,
              invalidUtf8: false,
            };
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        const loading = yield* Effect.forkChild(service.list);
        yield* Deferred.await(accountStarted);
        yield* Deferred.await(inventoryStarted);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(loading)).toEqual({ account: "example", codespaces: [] });
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect(
    "rejects thread management of another project's Codespace before GitHub mutation",
    () => {
      const test = harness();
      return Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        for (const action of ["stop", "delete", "update", "start", "connect", "rebuild"] as const) {
          const result = yield* service
            .run(
              {
                action,
                name: "another-project-space",
                projectId: ProjectId.make("project-test"),
                clientRequestId: "scope-" + action,
              },
              ProjectId.make("project-test"),
            )
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.code).toBe("permission");
        }
        expect(test.requests).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("keeps the local target when work starts during GitHub creation", () => {
    const threads: Array<
      Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "status" | "pendingRuntimeRequest">
    > = [];
    const test = harness({
      threads,
      rest: (input) =>
        Effect.sync(() => {
          if (input.path === "user/codespaces" && input.method === "POST")
            threads.push({
              id: ThreadId.make("new-local-turn"),
              projectId: ProjectId.make("project-test"),
              status: "running",
              pendingRuntimeRequest: null,
            });
          return {
            status: 200,
            headers: {},
            body: json(
              input.path === "user"
                ? { login: "example" }
                : input.path === "repos/example/fork"
                  ? { id: 42 }
                  : raw(),
            ),
            truncated: false,
            invalidUtf8: false,
          };
        }),
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.run(create);
      const operation = yield* completed(service, create.clientRequestId);
      expect(operation.status).toBe("failed");
      expect(operation.name).toBe("test-space-1");
      expect(operation.message).toContain("Stop active turns");
      expect(test.targetEvents).toEqual([]);
      expect(test.connects()).toBe(0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "closes only this project's terminals before changing targets, preserving history",
    () => {
      const projectId = ProjectId.make("project-test");
      const test = harness({
        threads: [
          { id: ThreadId.make("owned"), projectId, status: "idle", pendingRuntimeRequest: null },
          {
            id: ThreadId.make("other"),
            projectId: ProjectId.make("other"),
            status: "idle",
            pendingRuntimeRequest: null,
          },
        ],
      });
      return Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        yield* service.bind({ projectId, name: managed.name });
        expect((yield* service.snapshot).bindingRevision).toBe(1);
        yield* service.bind({ projectId, name: null });
        const changed = yield* service.changes.pipe(Stream.runHead);
        expect(Option.getOrThrow(changed).bindingRevision).toBe(2);
        expect(test.targetEvents).toEqual([
          "close:owned",
          "bind:test-space-1",
          "close:owned",
          "bind:null",
        ]);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect("refuses switching targets while a turn waits for approval", () => {
    const projectId = ProjectId.make("project-test");
    const test = harness({
      threads: [
        { id: ThreadId.make("waiting"), projectId, status: "waiting", pendingRuntimeRequest: null },
      ],
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      expect((yield* service.bind({ projectId, name: null }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.targetEvents).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("disconnects forwards belonging to the previous GitHub account", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.run({
        action: "connect",
        projectId: ProjectId.make("project-test"),
        name: managed.name,
        clientRequestId: "connect-account",
      });
      yield* completed(service, "connect-account");
      test.account("different");
      yield* service.list;
      expect(test.disconnects()).toBe(1);
      expect((yield* service.snapshot).environments[0]?.connected).toBe(false);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("deletes compute and removes the controller record after inspecting work", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.configure(configuration);
      yield* service.run({
        action: "connect",
        projectId: ProjectId.make("project-test"),
        name: "test-space-1",
        clientRequestId: "connect-delete-test",
      });
      yield* completed(service, "connect-delete-test");
      yield* service.run({
        action: "delete",
        name: "test-space-1",
        clientRequestId: "delete-request-1",
      });
      expect((yield* completed(service, "delete-request-1")).status).toBe("succeeded");
      expect(test.requests.find((request) => request.method === "DELETE")?.path).toBe(
        "user/codespaces/test-space-1",
      );
      expect((yield* service.snapshot).environments).toEqual([]);
      expect(test.disconnects()).toBe(1);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("restores available forwards after restart only for the current GitHub account", () => {
    const test = harness({
      saved: new TextEncoder().encode(
        json({
          configuration,
          operations: [],
          requests: {},
          environments: [
            managed,
            { ...managed, name: "other-account-space", account: "other", codespaceId: 2 },
          ],
        }),
      ),
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      const restored = yield* service.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.operations.some((operation) => operation.status === "succeeded"),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(
        restored.environments.find((entry) => entry.name === managed.name)?.environmentId,
      ).toBe(managed.environmentId);
      expect(restored.environments.find((entry) => entry.account === "other")?.connected).toBe(
        false,
      );
      expect(test.connects()).toBe(1);
      expect(test.requests.some((request) => request.method === "POST")).toBe(false);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("requires stopped compute for resizing and sends rename updates through GitHub", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.run({
        action: "update",
        name: "test-space-1",
        machine: "basicLinux32gb",
        clientRequestId: "resize-request-1",
      });
      expect((yield* completed(service, "resize-request-1")).status).toBe("failed");
      expect(test.requests.some((request) => request.method === "PATCH")).toBe(false);
      yield* service.run({
        action: "update",
        name: "test-space-1",
        displayName: "Renamed",
        clientRequestId: "rename-request-1",
      });
      expect((yield* completed(service, "rename-request-1")).status).toBe("succeeded");
      expect(test.requests.find((request) => request.method === "PATCH")?.body).toEqual({
        display_name: "Renamed",
      });
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("rejects creation without a project before billable creation", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      const { projectId: _projectId, ...withoutProject } = create;
      const result = yield* service.run(withoutProject).pipe(Effect.flip);
      expect(result.code).toBe("configuration");
      expect(test.requests.some((request) => request.method === "POST")).toBe(false);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "persists acceptance and reuses identical create requests without creating twice",
    () => {
      const test = harness();
      return Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        yield* service.configure(configuration);
        const first = yield* service.run(create);
        expect(first.status).toBe("running");
        expect((yield* completed(service, create.clientRequestId)).status).toBe("succeeded");
        expect((yield* service.run(create)).status).toBe("succeeded");
        expect(
          test.requests.filter(
            (request) => request.path === "user/codespaces" && request.method === "POST",
          ),
        ).toHaveLength(1);
        expect(test.connects()).toBe(1);
        expect(test.saved().byteLength).toBeGreaterThan(0);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect("rejects request ID reuse with different inputs or accounts", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.configure(configuration);
      yield* service.run(create);
      yield* completed(service, create.clientRequestId);
      expect((yield* service.run({ ...create, retentionDays: 2 }).pipe(Effect.flip)).code).toBe(
        "conflict",
      );
      test.account("different");
      expect((yield* service.run(create).pipe(Effect.flip)).code).toBe("conflict");
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("serializes conflicting operations while work is running", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = harness({
        connect: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(managed),
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        yield* service.configure(configuration);
        yield* service.run({
          action: "connect",
          projectId: ProjectId.make("project-test"),
          name: managed.name,
          clientRequestId: "connect-request-1",
        });
        yield* Deferred.await(entered);
        expect(
          (yield* service
            .run({ action: "stop", name: managed.name, clientRequestId: "stop-request-1" })
            .pipe(Effect.flip)).code,
        ).toBe("busy");
        yield* Deferred.succeed(release, undefined);
        yield* completed(service, "connect-request-1");
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("pins API and host credentials for the duration of an accepted operation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const hostTokens: string[] = [];
      const test = harness({
        connect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            const credential = yield* GitHubApi.PinnedGitHubCredential;
            hostTokens.push(Redacted.value(credential!.token));
            return managed;
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        yield* service.configure(configuration);
        yield* service.run(create);
        yield* Deferred.await(entered);
        test.account("different");
        yield* Deferred.succeed(release, undefined);
        yield* completed(service, create.clientRequestId);
        expect(hostTokens).toEqual(["first-token"]);
        expect(new Set(test.pinnedTokens)).toEqual(new Set(["first-token"]));
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("refuses active work without issuing stop and allows explicit force", () => {
    const test = harness({
      prepareStop: (_environment, _configuration, force) =>
        force
          ? Effect.void
          : Effect.fail(new CodespacesError({ code: "conflict", message: "Active work" })),
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.configure(configuration);
      yield* service.run({
        action: "connect",
        projectId: ProjectId.make("project-test"),
        name: managed.name,
        clientRequestId: "connect-request-1",
      });
      yield* completed(service, "connect-request-1");
      yield* service.run({ action: "stop", name: managed.name, clientRequestId: "stop-request-1" });
      expect((yield* completed(service, "stop-request-1")).status).toBe("failed");
      expect(test.requests.some((request) => request.path.endsWith("/stop"))).toBe(false);
      yield* service.run({
        action: "stop",
        name: managed.name,
        clientRequestId: "stop-request-2",
        force: true,
      });
      expect((yield* completed(service, "stop-request-2")).status).toBe("succeeded");
      expect((yield* service.snapshot).environments[0]?.connected).toBe(false);
      expect(test.disconnects()).toBe(1);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("waits for slow GitHub shutdown before reporting stopped compute", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      let stopping = false;
      let checks = 0;
      const test = harness({
        rest: (input) =>
          Effect.gen(function* () {
            if (input.path.endsWith("/stop")) stopping = true;
            if (stopping && input.path === "user/codespaces/test-space-1") {
              checks++;
              yield* Deferred.succeed(waiting, undefined);
            }
            return {
              status: 200,
              headers: {},
              body: json(
                input.path === "user"
                  ? { login: "example" }
                  : raw(1, stopping ? (checks >= 65 ? "Shutdown" : "ShuttingDown") : "Available"),
              ),
              truncated: false,
              invalidUtf8: false,
            };
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Codespaces.Codespaces;
        yield* service.configure(configuration);
        yield* service.run({
          action: "connect",
          projectId: ProjectId.make("project-test"),
          name: managed.name,
          clientRequestId: "connect-slow-stop",
        });
        yield* completed(service, "connect-slow-stop");
        yield* service.run({
          action: "stop",
          name: managed.name,
          clientRequestId: "slow-stop",
        });
        yield* Deferred.await(waiting);
        expect((yield* service.snapshot).operations.at(-1)?.status).toBe("running");
        yield* TestClock.adjust("3 minutes");
        expect((yield* completed(service, "slow-stop")).status).toBe("succeeded");
        expect(test.requests.filter((request) => request.path.endsWith("/stop"))).toHaveLength(1);
        expect((yield* service.snapshot).environments[0]?.connected).toBe(false);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("does not wake a stopped Codespace on reconnect", () => {
    const test = harness({
      rest: (input) =>
        Effect.succeed({
          status: 200,
          headers: {},
          body: json(input.path === "user" ? { login: "example" } : raw(1, "Shutdown")),
          truncated: false,
          invalidUtf8: false,
        }),
    });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.configure(configuration);
      yield* service.run({
        action: "connect",
        projectId: ProjectId.make("project-test"),
        name: managed.name,
        clientRequestId: "connect-request-1",
      });
      expect((yield* completed(service, "connect-request-1")).status).toBe("failed");
      expect(test.requests.some((request) => request.method === "POST")).toBe(false);
      expect(test.connects()).toBe(0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("uses the host rebuild adapter rather than a nonexistent REST endpoint", () => {
    const test = harness();
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      yield* service.configure(configuration);
      yield* service.run({
        action: "rebuild",
        projectId: ProjectId.make("project-test"),
        name: managed.name,
        clientRequestId: "rebuild-request-1",
        force: true,
      });
      expect((yield* completed(service, "rebuild-request-1")).status).toBe("succeeded");
      expect(test.rebuilds()).toBe(1);
      expect(test.requests.some((request) => request.path.endsWith("/rebuild"))).toBe(false);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("lists every GitHub page", () => {
    const test = harness({
      rest: (input) =>
        Effect.succeed({
          status: 200,
          headers: {},
          body: json(
            input.path === "user"
              ? { login: "example" }
              : {
                  codespaces: input.path.endsWith("page=1")
                    ? Array.from({ length: 100 }, (_, index) => raw(index + 1))
                    : [raw(101)],
                },
          ),
          truncated: false,
          invalidUtf8: false,
        }),
    });
    return Effect.gen(function* () {
      expect((yield* (yield* Codespaces.Codespaces).list).codespaces).toHaveLength(101);
      expect(
        test.requests.filter((request) => request.path.startsWith("user/codespaces?")),
      ).toHaveLength(2);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("records interruption after restart without replaying create", () => {
    const saved = new TextEncoder().encode(
      json({
        configuration,
        environments: [],
        requests: {
          "create-request-1": requestKey({ account: "example", input: create }),
        },
        operations: [
          {
            clientRequestId: "create-request-1",
            action: "create",
            name: null,
            status: "running",
            stage: "creating",
            message: "Creating",
            createdAt: "2026-10-08T00:00:00Z",
          },
        ],
      }),
    );
    const test = harness({ saved });
    return Effect.gen(function* () {
      const service = yield* Codespaces.Codespaces;
      expect((yield* service.run(create)).status).toBe("failed");
      expect(test.requests.some((request) => request.method === "POST")).toBe(false);
      expect((yield* service.snapshot).operations[0]?.message).toContain("will not be replayed");
    }).pipe(Effect.provide(test.layer));
  });
});

it.effect("ignores scripts beside devcontainer configurations", () => {
  const test = harness({
    devcontainerEntries: ["on-create.sh", "update-content.sh", "fork-update"],
  });
  return Effect.gen(function* () {
    const service = yield* Codespaces.Codespaces;
    const info = yield* service.project({ projectId: ProjectId.make("project-test") });
    expect(info.eligible).toBe(true);
    expect(info.devcontainerPaths).toEqual([
      ".devcontainer/devcontainer.json",
      ".devcontainer/fork-update/devcontainer.json",
    ]);
  }).pipe(Effect.provide(test.layer));
});
