import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  CodespacesError,
  VcsProcessExitError,
  type Codespace,
  type CodespacesConfiguration,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as Net from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CodespacesHost from "./CodespacesHost.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const configuration: CodespacesConfiguration = {
  releaseBaseUrl: "https://github.com/example/fork/releases/download",
  archiveVersion: "0.0.46",
  remoteScriptPath: "",
  publicUrlTemplate: "https://{name}.example.com",
  networkAccess: false,
  agentAccessEnabled: false,
};
const space: Codespace = {
  id: 1,
  name: "test-space",
  displayName: "Test",
  repository: "example/fork",
  branch: "main",
  state: "Available",
  machine: "standardLinux32gb",
  webUrl: "https://github.com/codespaces",
  idleTimeoutMinutes: 30,
  retentionMinutes: 1440,
};
const environmentId = EnvironmentId.make("codespace-host-test");

const harness = Effect.gen(function* () {
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const commands: VcsProcess.VcsProcessInput[] = [];
  let forwards = 0;
  let port = 12344;
  let availability = () => Effect.succeed(true);
  const executors: CodespacesWorkspace.WorkspaceExecutor[] = [];
  let activeExecutor = false;
  let registration = () => Effect.void as Effect.Effect<void, CodespacesError>;
  let launchFailure: "invalid-output" | "ssh" | undefined;
  let thread: { status: string; pendingRuntimeRequest: unknown; activityRunStatus?: string } = {
    status: "idle",
    pendingRuntimeRequest: null,
  };
  let descriptorId = environmentId;
  let respond: (input: VcsProcess.VcsProcessInput) => string | undefined = () => undefined;
  let healthy = (_authorization: string | undefined) => true;
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag === "StandardCommand")
        spawned.push({ command: command.command, args: command.args });
      forwards++;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          forwards--;
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exit),
        isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const layer = CodespacesHost.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.succeed("// bundled test worker"),
          makeTempDirectoryScoped: () => Effect.succeed("/tmp/t3cs-test"),
          writeFileString: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
          register: (executor) =>
            Effect.suspend(() => registration()).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  executors.push(executor);
                  activeExecutor = true;
                }),
              ),
            ),
          disconnect: () =>
            Effect.sync(() => {
              activeExecutor = false;
            }),
        }),
        ServerConfig.layerTest("/tmp/t3-codespaces-host-test", "/tmp"),
        Layer.mock(Net.NetService)({
          reserveLoopbackPort: () => Effect.sync(() => ++port),
          isPortAvailableOnLoopback: () => availability(),
        }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(GitHubCredentials.GitHubCredentials, {
          get: () =>
            Effect.succeed({
              host: "github.com",
              token: Redacted.make("selected-account-token"),
              source: "gh" as const,
              fingerprint: "selected-account",
            }),
          invalidate: () => Effect.void,
        }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              commands.push(input);
              if (input.stdin !== undefined) expect(activeExecutor).toBe(false);
              if (launchFailure === "ssh")
                return yield* new VcsProcessExitError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  exitCode: 1,
                  detail: "SSH disconnected during replacement",
                });
              const stdout = json({
                workerPort: 3773,
                execPort: 3774,
                workspacePath: "/workspaces/custom-folder",
              });
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout:
                  respond(input) ??
                  (launchFailure === "invalid-output" ? "worker-did-not-start" : stdout),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              request.url.endsWith("/health") && !healthy(request.headers.authorization)
                ? HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))
                : HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      json(
                        request.url.endsWith("/.well-known/t3/environment")
                          ? {
                              environmentId: descriptorId,
                              label: "Test",
                              platform: { os: "linux", arch: "x64" },
                              serverVersion: "0.0.46",
                              capabilities: { repositoryIdentity: true },
                            }
                          : request.url.endsWith("/oauth/token")
                            ? { access_token: "test-token" }
                            : { threads: [thread] },
                      ),
                      { headers: { "content-type": "application/json" } },
                    ),
                  ),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return {
    layer,
    commands,
    executors,
    activeExecutor: () => activeExecutor,
    registration: (value: typeof registration) => {
      registration = value;
    },
    failLaunch: (value: typeof launchFailure) => {
      launchFailure = value;
    },
    exit,
    forwards: () => forwards,
    availability: (value: typeof availability) => {
      availability = value;
    },
    thread: (value: typeof thread) => {
      thread = value;
    },
    descriptor: (value: EnvironmentId) => {
      descriptorId = value;
    },
    respond: (value: typeof respond) => {
      respond = value;
    },
    healthy: (value: typeof healthy) => {
      healthy = value;
    },
    spawned,
  };
});

describe("Codespaces SSH host", () => {
  it.effect("failed replacement clears old forwards and executor registration before launch", () =>
    Effect.gen(function* () {
      for (const failure of ["invalid-output", "ssh"] as const) {
        const test = yield* harness;
        yield* Effect.gen(function* () {
          const host = yield* CodespacesHost.CodespacesHost;
          const first = yield* host.connect(space, "example", configuration);
          expect(test.activeExecutor()).toBe(true);
          expect(test.forwards()).toBe(1);
          test.failLaunch(failure);
          expect(
            (yield* host.connect(space, "example", configuration, first).pipe(Effect.flip)).code,
          ).toBe("bootstrap");
          expect(test.forwards()).toBe(0);
          expect(test.activeExecutor()).toBe(false);
          expect(test.executors).toHaveLength(1);
        }).pipe(Effect.provide(test.layer));
      }
    }),
  );
  it.effect("closes SSH forwards when workspace registration fails", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      test.registration(() =>
        Effect.fail(new CodespacesError({ code: "storage", message: "Save failed." })),
      );
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const error = yield* host.connect(space, "example", configuration).pipe(Effect.flip);
        expect(error.code).toBe("storage");
        expect(test.forwards()).toBe(0);
        expect(test.activeExecutor()).toBe(false);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("refuses a connection that exits during workspace registration", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      test.registration(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(ready))),
      );
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const disconnected = yield* host.disconnected.pipe(
          Stream.filter((name) => name === space.name),
          Stream.runHead,
          Effect.forkChild,
        );
        const pending = yield* host
          .connect(space, "example", configuration)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Deferred.succeed(test.exit, ChildProcessSpawner.ExitCode(1));
        yield* Fiber.join(disconnected);
        yield* Deferred.succeed(ready, undefined);
        const error = yield* Fiber.join(pending);
        expect(error.code).toBe("bootstrap");
        expect(test.forwards()).toBe(0);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("starts workspace-only workers and replaces owned forwards", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const first = yield* host.connect(space, "example", configuration);
        expect(first.workspacePath).toBe("/workspaces/custom-folder");
        expect(first.environmentId).toBeNull();
        expect(test.forwards()).toBe(1);
        expect(test.executors[0]?.execServerUrl).toBe("ws://127.0.0.1:12346");
        const launch = test.commands.find((command) => command.stdin?.includes("exec-server"));
        expect(launch?.stdin).not.toContain("auth pairing create");
        expect(launch?.stdin).not.toContain("provider login");
        const second = yield* host.connect(space, "example", configuration, first).pipe(
          Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make("pinned-account-token"),
            credentialFingerprint: "pinned",
          }),
        );
        expect(second.localPort).not.toBe(first.localPort);
        expect(test.forwards()).toBe(1);
        expect(test.commands.at(-1)?.env?.GH_TOKEN).toBe("pinned-account-token");
        yield* host.disconnect(space.name);
        expect(test.forwards()).toBe(0);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("shares a ready preview forward between concurrent callers", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        yield* host.connect(space, "example", configuration);
        test.availability(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(ready)),
            Effect.as(false),
          ),
        );
        const executor = test.executors[0]!;
        const first = yield* executor.forwardPort!(3000).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* executor.forwardPort!(3000).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(second.pollUnsafe()).toBeUndefined();
        expect(executor.isForwardedPort!(12347)).toBe(false);
        expect(test.forwards()).toBe(2);
        yield* Deferred.succeed(ready, undefined);
        const firstPort = yield* Fiber.join(first);
        const secondPort = yield* Fiber.join(second);
        expect(secondPort).toBe(firstPort);
        expect(executor.isForwardedPort!(firstPort)).toBe(true);
        yield* host.disconnect(space.name);
        expect(test.forwards()).toBe(0);
        expect(executor.isForwardedPort!(firstPort)).toBe(false);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("cleans up an interrupted preview forward before retrying", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        yield* host.connect(space, "example", configuration);
        test.availability(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(ready)),
            Effect.as(false),
          ),
        );
        const executor = test.executors[0]!;
        const pending = yield* executor.forwardPort!(3000).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(pending);
        expect(test.forwards()).toBe(1);
        test.availability(() => Effect.succeed(false));
        const port = yield* executor.forwardPort!(3000);
        expect(port).toBe(12348);
        expect(test.forwards()).toBe(2);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("refuses obsolete environment pairing", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const managed = yield* host.connect(space, "example", configuration);
        const error = yield* host.pair(managed, configuration, false).pipe(Effect.flip);
        expect(error.code).toBe("configuration");
        expect(error.message).toContain("local project");
      }).pipe(Effect.provide(test.layer));
    }),
  );
});

const attachedWorker = json({
  launch: { workerPort: 4000, execPort: 4001, workspacePath: "/workspaces/custom-folder" },
  token: "running-worker-token",
});
const isAttach = (input: VcsProcess.VcsProcessInput) => input.stdin?.includes("stale()") ?? false;
const isLaunch = (input: VcsProcess.VcsProcessInput) =>
  input.stdin?.includes("exec-server") ?? false;

describe("Codespaces worker reattachment", () => {
  it.effect("reuses a running worker without relaunching it", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      test.respond((input) => (isAttach(input) ? attachedWorker : undefined));
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const managed = yield* host.connect(space, "example", configuration);
        expect(managed.remotePort).toBe(4000);
        expect(test.executors[0]?.token).toBe("running-worker-token");
        expect(test.commands.some(isLaunch)).toBe(false);
        expect(test.forwards()).toBe(1);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("relaunches a worker started by a different launcher", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      test.respond((input) => (isAttach(input) ? "stale" : undefined));
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const managed = yield* host.connect(space, "example", configuration);
        expect(managed.remotePort).toBe(3773);
        const attach = test.commands.find(isAttach);
        const launch = test.commands.find(isLaunch);
        // Launch records the fingerprint the next attach requires.
        expect(launch?.args.at(-1)).toBe(attach?.args.at(-1));
        expect(test.executors[0]?.token).not.toBe("running-worker-token");
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect("relaunches a running worker that stops answering", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      test.respond((input) => (isAttach(input) ? attachedWorker : undefined));
      test.healthy((authorization) => authorization !== "Bearer running-worker-token");
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        const pending = yield* host.connect(space, "example", configuration).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const managed = yield* Fiber.join(pending);
        expect(managed.remotePort).toBe(3773);
        expect(test.commands.some(isLaunch)).toBe(true);
        expect(test.executors).toHaveLength(1);
        expect(test.forwards()).toBe(1);
      }).pipe(Effect.provide(test.layer));
    }),
  );
});

describe("Codespaces shared SSH connection", () => {
  it.effect("carries setup, worker and preview forwards over one SSH connection", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      test.respond((input) =>
        input.args.includes("--config")
          ? "Host cs.test-space.main\n\tUser node\n"
          : input.args.includes("-O")
            ? ""
            : undefined,
      );
      yield* Effect.gen(function* () {
        const host = yield* CodespacesHost.CodespacesHost;
        yield* host.connect(space, "example", configuration);
        test.availability(() => Effect.succeed(false));
        const port = yield* test.executors[0]!.forwardPort!(3000);
        expect(test.spawned).toHaveLength(1);
        expect(test.spawned[0]?.command).toBe("ssh");
        expect(test.spawned[0]?.args).toContain("ControlMaster=yes");
        expect(test.commands.find(isLaunch)?.command).toBe("ssh");
        expect(
          test.commands
            .filter((input) => input.args.includes("forward"))
            .map((input) => input.args.filter((arg) => arg.startsWith("127.0.0.1:"))),
        ).toEqual([
          ["127.0.0.1:12345:127.0.0.1:3773", "127.0.0.1:12346:127.0.0.1:3774"],
          [`127.0.0.1:${port}:127.0.0.1:3000`],
        ]);
        expect(test.forwards()).toBe(1);
        yield* host.disconnect(space.name);
        expect(test.forwards()).toBe(0);
      }).pipe(Effect.provide(test.layer));
    }),
  );
});
