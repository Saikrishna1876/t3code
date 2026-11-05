import * as CodespacesWorkspace from "../codespaces/CodespacesWorkspace.ts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Redacted from "effect/Redacted";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

function makeNativeProcess(pid = 42) {
  const events = new NodeEvents.EventEmitter();
  return {
    pid,
    _socket: new NodeNet.Socket(),
    _agent: { kill: vi.fn() },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => {
      events.on("data", callback);
      return {
        dispose: () => {
          events.off("data", callback);
        },
      };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
      events.on("exit", callback);
      return {
        dispose: () => {
          events.off("exit", callback);
        },
      };
    }),
    events,
  };
}

const spawn = vi.fn((..._args: Parameters<typeof import("node-pty").spawn>) => makeNativeProcess());

function preparePendingProcess() {
  const nativeProcess = makeNativeProcess(0);
  const subscribed = Promise.withResolvers<void>();
  nativeProcess._socket.on("newListener", (event) => {
    if (event === "ready_datapipe") queueMicrotask(() => subscribed.resolve());
  });
  spawn.mockReturnValueOnce(nativeProcess);
  return { nativeProcess, subscribed: Effect.promise(() => subscribed.promise) };
}

const spawnInput = { shell: "powershell.exe", cwd: ".", cols: 80, rows: 24, env: {} };

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const layerTestFor = (platform: NodeJS.Platform = "win32") =>
  NodePtyAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcess.Platform, platform),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
      ),
    ),
  );

const layerTest = layerTestFor();

it.effect("waits for the Windows PID without requiring output", () =>
  Effect.gen(function* () {
    const { nativeProcess, subscribed } = preparePendingProcess();
    const adapter = yield* PtyAdapter.PtyAdapter;
    let completed = false;
    const fiber = yield* adapter.spawn(spawnInput).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* subscribed;
    assert.isFalse(completed);
    nativeProcess.pid = 12345;
    nativeProcess._socket.emit("ready_datapipe");
    const process = yield* Fiber.join(fiber);
    assert.equal(process.pid, 12345);
    assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 1);

    const output: string[] = [];
    const exits: PtyAdapter.PtyExitEvent[] = [];
    const stopData = process.onData((data) => output.push(data));
    const stopExit = process.onExit((event) => exits.push(event));
    nativeProcess.events.emit("data", "first output");
    nativeProcess.events.emit("exit", { exitCode: 0 });
    assert.deepEqual(output, ["first output"]);
    assert.deepEqual(exits, [{ exitCode: 0, signal: null }]);
    stopData();
    stopExit();
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["exit", "close", "error", "invalid-pid"] as const)(
  "fails Windows startup on %s and cleans up",
  (failure) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const adapter = yield* PtyAdapter.PtyAdapter;
      const fiber = yield* adapter.spawn(spawnInput).pipe(Effect.result, Effect.forkChild);
      yield* subscribed;
      if (failure === "exit") nativeProcess.events.emit("exit", { exitCode: 1 });
      else if (failure === "error") nativeProcess._socket.emit("error", new Error("pipe failed"));
      else nativeProcess._socket.emit(failure === "close" ? "close" : "ready_datapipe");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PtyAdapter.PtySpawnError);
      assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
      assert.equal(nativeProcess._socket.listenerCount("error"), 0);
      assert.equal(nativeProcess._socket.listenerCount("close"), 0);
      assert.equal(nativeProcess.events.listenerCount("exit"), 0);
      assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("cancels the Windows connection without waiting for output", () =>
  Effect.gen(function* () {
    const { nativeProcess, subscribed } = preparePendingProcess();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const fiber = yield* adapter.spawn(spawnInput).pipe(Effect.forkChild);
    yield* subscribed;
    yield* Fiber.interrupt(fiber);
    assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
    assert.equal(nativeProcess.kill.mock.calls.length, 0);
    assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports an incompatible Windows readiness API instead of hanging", () =>
  Effect.gen(function* () {
    const nativeProcess = makeNativeProcess(0);
    Reflect.deleteProperty(nativeProcess, "_socket");
    spawn.mockReturnValueOnce(nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;
    const error = yield* adapter.spawn(spawnInput).pipe(Effect.flip);
    assert.instanceOf(error, PtyAdapter.PtySpawnError);
    assert.instanceOf(error.cause, Error);
    assert.equal(error.cause.message, "Windows PTY readiness socket is unavailable.");
    assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([2048, 8])(
  "preserves an exit during readiness handoff with scheduler budget %s",
  (budget) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const adapter = yield* PtyAdapter.PtyAdapter;
      const exits: PtyAdapter.PtyExitEvent[] = [];
      const fiber = yield* Effect.gen(function* () {
        const process = yield* adapter.spawn(spawnInput);
        process.onExit((event) => exits.push(event));
      }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
        Effect.provideService(Scheduler.PreventSchedulerYield, false),
        Effect.forkChild,
      );
      yield* subscribed;
      nativeProcess.pid = 12345;
      nativeProcess._socket.emit("ready_datapipe");
      nativeProcess.events.emit("exit", { exitCode: 0 });
      yield* Fiber.join(fiber);
      assert.equal(exits.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("replays an exit to late subscribers and respects unsubscription", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(spawnInput);
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    const removed = vi.fn();
    process.onExit(removed)();
    nativeProcess.events.emit("exit", { exitCode: 7, signal: 2 });
    const late = vi.fn();
    process.onExit(late);
    nativeProcess.events.emit("exit", { exitCode: 9 });
    assert.equal(removed.mock.calls.length, 0);
    assert.deepEqual(late.mock.calls, [[{ exitCode: 7, signal: 2 }]]);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.live("starts a remote worktree terminal from an existing host directory", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      ...spawnInput,
      cwd: "/host/project/.git/t3-codespaces/space/.git/t3-worktrees/project/feature",
      env: {
        T3CODE_PROJECT_ROOT: "/host/project/.git/t3-codespaces/space",
        T3CODE_WORKTREE_PATH:
          "/host/project/.git/t3-codespaces/space/.git/t3-worktrees/project/feature",
        HOST_ONLY_SECRET: "must-stay-local",
      },
    });
    const call = spawn.mock.calls.at(-1)!;
    assert.equal(call[0], "gh");
    assert.equal(call[2]?.cwd, "/host/project");
    process.kill();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-startup-" });
    const checkout = path.join(root, "checkout");
    const home = path.join(root, "home");
    yield* fs.makeDirectory(checkout);
    yield* fs.makeDirectory(home);
    const startup = `cd '${home}'\n`;
    yield* fs.writeFileString(
      path.join(home, ".bash_profile"),
      startup + "export T3_LOGIN_PROFILE=loaded\n",
    );
    yield* fs.writeFileString(path.join(home, ".bashrc"), startup);
    const command = String(call[1]?.at(-1)).replaceAll(
      "/workspaces/project/.git/t3-worktrees/project/feature",
      checkout,
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", command], {
        env: { ...globalThis.process.env, HOME: home },
        stdin: {
          stream: Stream.encodeText(
            Stream.make(
              'printf "T3_CWD=%s\\nT3_ROOT=%s\\nT3_WORKTREE=%s\\nT3_SECRET=%s\\nT3_PROFILE=%s\\n" "$PWD" "$T3CODE_PROJECT_ROOT" "$T3CODE_WORKTREE_PATH" "$HOST_ONLY_SECRET" "$T3_LOGIN_PROFILE"\nexit\n',
            ),
          ),
        },
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        ),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(exitCode, 0);
    assert.include(output, `T3_CWD=${checkout}`);
    assert.include(output, "T3_ROOT=/workspaces/project");
    assert.include(output, `T3_WORKTREE=${checkout}`);
    assert.include(output, "T3_SECRET=\n");
    assert.include(output, "T3_PROFILE=loaded\n");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        layerTestFor("darwin").pipe(
          Layer.provide(
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: () =>
                Effect.succeed({
                  host: "github.com",
                  token: Redacted.make("fixture"),
                  source: "gh",
                  fingerprint: "fixture",
                }),
            }),
          ),
        ),
        Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
          lookup: () =>
            Effect.succeed({
              projectId: "project",
              name: "space",
              hostRoot: "/host/project",
              localRoot: "/host/project/.git/t3-codespaces/space",
              remoteCwd: "/workspaces/project/.git/t3-worktrees/project/feature",
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
  ),
);
