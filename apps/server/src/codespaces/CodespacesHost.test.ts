import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type Codespace, type CodespacesConfiguration } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as Net from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
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
  const executors: CodespacesWorkspace.WorkspaceExecutor[] = [];
  let thread: { status: string; pendingRuntimeRequest: unknown; activityRunStatus?: string } = {
    status: "idle",
    pendingRuntimeRequest: null,
  };
  let descriptorId = environmentId;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
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
        isRunning: Effect.succeed(true),
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
      Layer.mergeAll(
        Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
          register: (executor) =>
            Effect.sync(() => {
              executors.push(executor);
            }),
          disconnect: () => Effect.void,
        }),
        ServerConfig.layerTest("/tmp/t3-codespaces-host-test", "/tmp"),
        Layer.mock(Net.NetService)({
          reserveLoopbackPort: () => Effect.sync(() => ++port),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
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
            Effect.sync(() => {
              commands.push(input);
              const stdout = json({
                workerPort: 3773,
                execPort: 3774,
                workspacePath: "/workspaces/custom-folder",
              });
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout,
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
              HttpClientResponse.fromWeb(
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
    exit,
    forwards: () => forwards,
    thread: (value: typeof thread) => {
      thread = value;
    },
    descriptor: (value: EnvironmentId) => {
      descriptorId = value;
    },
  };
});

describe("Codespaces SSH host", () => {
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
        expect(test.commands[0]?.stdin).toContain("exec-server");
        expect(test.commands[0]?.stdin).not.toContain("auth pairing create");
        expect(test.commands[0]?.stdin).not.toContain("provider login");
        const second = yield* host.connect(space, "example", configuration, first).pipe(
          Effect.provideService(GitHubApi.PinnedGitHubCredential, {
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
