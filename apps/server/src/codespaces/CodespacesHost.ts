import serverPackage from "../../package.json" with { type: "json" };
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  CodespacesError,
  type Codespace,
  type CodespacesConfiguration,
  type CodespacesManagedEnvironment,
  type CodespacesPairResult,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Crypto from "effect/Crypto";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import { workspaceWorkerSource } from "./workerSource.ts";

export class CodespacesHost extends Context.Service<
  CodespacesHost,
  {
    readonly connect: (
      space: Codespace,
      account: string,
      configuration: CodespacesConfiguration,
      previous?: CodespacesManagedEnvironment,
    ) => Effect.Effect<CodespacesManagedEnvironment, CodespacesError>;
    readonly pair: (
      environment: CodespacesManagedEnvironment,
      configuration: CodespacesConfiguration,
      remote: boolean,
    ) => Effect.Effect<CodespacesPairResult, CodespacesError>;
    readonly prepareStop: (
      environment: CodespacesManagedEnvironment,
      configuration: CodespacesConfiguration,
      force: boolean,
    ) => Effect.Effect<void, CodespacesError>;
    readonly rebuild: (name: string) => Effect.Effect<void, CodespacesError>;
    readonly disconnect: (name: string) => Effect.Effect<void>;
    readonly disconnected: Stream.Stream<string>;
  }
>()("t3/codespaces/CodespacesHost") {}

const launchResult = Schema.fromJsonString(
  Schema.Struct({ workerPort: Schema.Int, execPort: Schema.Int, workspacePath: Schema.String }),
);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const getWorkerSource = workspaceWorkerSource.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const processRunner = yield* VcsProcess.VcsProcess;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* Net.NetService;
  const config = yield* ServerConfig.ServerConfig;
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const workspaces = yield* CodespacesWorkspace.CodespacesWorkspace;
  const lifetime = yield* Effect.scope;
  const exits = yield* SubscriptionRef.make({ name: "", generation: 0 });
  const forwards = new Map<
    string,
    { scope: Scope.Closeable; process: ChildProcessSpawner.ChildProcessHandle }
  >();
  const ghEnvironment = Effect.gen(function* () {
    const pinned = yield* GitHubApi.PinnedGitHubCredential;
    const token = pinned?.token ?? (yield* credentials.get("github.com")).token;
    return {
      GH_TOKEN: Redacted.value(token),
      GH_HOST: "github.com",
      GH_DEBUG: "",
      GH_PROMPT_DISABLED: "1",
    };
  }).pipe(
    Effect.mapError(
      () =>
        new CodespacesError({
          code: "authentication",
          message: "Sign in to GitHub on this machine with the codespace scope.",
        }),
    ),
  );
  const ssh = (name: string, script: string, args: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const output = yield* processRunner
        .run({
          operation: "Codespaces.ssh",
          command: "gh",
          args: [
            "codespace",
            "ssh",
            "--codespace",
            name,
            "--",
            "-T",
            "sh",
            "-l",
            "-s",
            "--",
            ...args,
          ],
          cwd: config.cwd,
          stdin: script,
          env: yield* ghEnvironment,
          timeoutMs: 900_000,
          maxOutputBytes: 100_000,
        })
        .pipe(
          Effect.mapError(
            () =>
              new CodespacesError({
                code: "bootstrap",
                message:
                  "Codespace worker setup failed. Check its GitHub creation log and SSH server, then reconnect.",
              }),
          ),
        );
      return output.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    });
  const disconnect = (name: string) =>
    Effect.gen(function* () {
      yield* workspaces.disconnect(name);
      const entry = forwards.get(name);
      if (!entry) return;
      forwards.delete(name);
      yield* Scope.close(entry.scope, Exit.void);
    });
  const connect: CodespacesHost["Service"]["connect"] = Effect.fn("CodespacesHost.connect")(
    function* (space, account) {
      const token =
        (yield* crypto.randomUUIDv4.pipe(Effect.orDie)) +
        (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const worker = yield* getWorkerSource;
      const script = `set -eu
state="/workspaces/.t3-executors/$1"
mkdir -p "$state"
chmod 700 "$state"
workspace="\${CODESPACE_VSCODE_FOLDER:-}"
if [ ! -d "$workspace/.git" ] && [ ! -f "$workspace/.git" ]; then
  workspace=""
  for directory in /workspaces/*; do
    [ -d "$directory/.git" ] || [ -f "$directory/.git" ] || continue
    remote=$(git -C "$directory" remote get-url origin 2>/dev/null || true)
    case "$remote" in *"$2"|*"$2.git") workspace="$directory"; break ;; esac
  done
fi
[ -n "$workspace" ] || { echo 'workspace-not-found' >&2; exit 1; }
workspace=$(realpath "$workspace")
command -v node >/dev/null || { echo 'node-required' >&2; exit 1; }
# Only stop PIDs recorded by this launcher, after verifying their executor directory.
for service in worker executor; do
  if [ -f "$state/$service.pid" ]; then
    pid=$(cat "$state/$service.pid")
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if [ -r "/proc/$pid/cmdline" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -F "$state/" >/dev/null; then kill "$pid" 2>/dev/null || true; fi
  fi
done
printf '%s' '${token}' > "$state/token"
chmod 600 "$state/token"
base64 -d > "$state/worker.mjs" <<'WORKER'
${Buffer.from(worker).toString("base64")}
WORKER
binary="$state/codex-0.160.1"
if [ ! -x "$binary" ]; then
  case "$(uname -m)" in x86_64) target=x86_64-unknown-linux-musl ;; aarch64|arm64) target=aarch64-unknown-linux-musl ;; *) exit 1 ;; esac
  curl -fsSL --retry 2 "https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-$target.tar.gz" -o "$state/codex.tar.gz"
  tar -xzf "$state/codex.tar.gz" -C "$state"
  mv "$state/codex-$target" "$binary"
  chmod 700 "$binary"
  rm -f "$state/codex.tar.gz"
fi
# Match the host's pinned native search engine. Reuse this private installation on reconnect.
search_package="$state/node_modules/@ff-labs/fff-node/package.json"
if ! node - "$search_package" <<'NODE'
const fs = require('node:fs');
try { process.exit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).version === '${serverPackage.dependencies["@ff-labs/fff-node"]}' ? 0 : 1); }
catch { process.exit(1); }
NODE
then
  command -v npm >/dev/null || { echo 'npm-required-for-search' >&2; exit 1; }
  npm install --prefix "$state" --no-audit --no-fund --ignore-scripts --save-exact @ff-labs/fff-node@${serverPackage.dependencies["@ff-labs/fff-node"]} > "$state/search-install.log" 2>&1
fi
# Apply the host package's require export patch; its ASAR path patch is desktop-only.
node - "$search_package" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
metadata.exports['.'].require = metadata.exports['.'].import;
fs.writeFileSync(file, JSON.stringify(metadata));
NODE
exec_port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
cd "$workspace"
nohup "$binary" exec-server --listen "ws://127.0.0.1:$exec_port" --ws-auth capability-token --ws-token-file "$state/token" > "$state/executor.log" 2>&1 < /dev/null &
printf '%s' "$!" > "$state/executor.pid"
nohup node "$state/worker.mjs" "$workspace" "$state/token" > "$state/worker.log" 2>&1 < /dev/null &
printf '%s' "$!" > "$state/worker.pid"
node - "$state/worker.log" "$exec_port" "$workspace" <<'NODE'
const fs=require('fs'); const [log,execPort,workspacePath]=process.argv.slice(2);
const deadline=Date.now()+30000;
const timer=setInterval(()=>{
 try { const value=JSON.parse(fs.readFileSync(log,'utf8').trim().split('\\n').at(-1)); clearInterval(timer);console.log(JSON.stringify({workerPort:value.port,execPort:Number(execPort),workspacePath})); }
 catch { if(Date.now()>deadline){clearInterval(timer);process.exit(1)} }
},100);
NODE
`;
      // Relaunch can stop the remote processes even when SSH never returns their replacements.
      yield* disconnect(space.name);
      const result = yield* Schema.decodeEffect(launchResult)(
        yield* ssh(space.name, script, [`${account}-${space.id}`, space.repository]),
      ).pipe(
        Effect.mapError(
          () =>
            new CodespacesError({
              code: "bootstrap",
              message:
                "Codespace worker did not report ready. Check its worker log, then reconnect.",
            }),
        ),
      );
      const localPort = yield* net.reserveLoopbackPort().pipe(
        Effect.mapError(
          () =>
            new CodespacesError({
              code: "bootstrap",
              message: "Could not reserve a workspace forwarding port.",
            }),
        ),
      );
      const execPort = yield* net.reserveLoopbackPort().pipe(
        Effect.mapError(
          () =>
            new CodespacesError({
              code: "bootstrap",
              message: "Could not reserve an executor forwarding port.",
            }),
        ),
      );
      const scope = yield* Scope.make();
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            "gh",
            [
              "codespace",
              "ssh",
              "--codespace",
              space.name,
              "--",
              "-N",
              "-T",
              "-o",
              "ExitOnForwardFailure=yes",
              "-o",
              "ServerAliveInterval=15",
              "-o",
              "ServerAliveCountMax=3",
              "-L",
              `127.0.0.1:${localPort}:127.0.0.1:${result.workerPort}`,
              "-L",
              `127.0.0.1:${execPort}:127.0.0.1:${result.execPort}`,
            ],
            {
              env: yield* ghEnvironment,
              extendEnv: true,
              stdin: { stream: Stream.empty, endOnDone: true },
            },
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            () =>
              new CodespacesError({
                code: "bootstrap",
                message: "Could not open the Codespace SSH connection.",
              }),
          ),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      forwards.set(space.name, { scope, process: child });
      yield* Stream.runDrain(child.stdout).pipe(Effect.ignore, Effect.forkIn(scope));
      yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkIn(scope));
      yield* Effect.addFinalizer(() => disconnect(space.name)).pipe(
        Effect.provideService(Scope.Scope, lifetime),
      );
      yield* child.exitCode.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (forwards.get(space.name)?.process !== child) return;
            yield* disconnect(space.name);
            yield* SubscriptionRef.update(exits, (state) => ({
              name: space.name,
              generation: state.generation + 1,
            }));
          }),
        ),
        Effect.ignore,
        Effect.forkIn(lifetime),
      );
      yield* client
        .execute(
          HttpClientRequest.get(`http://127.0.0.1:${localPort}/health`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.retry({ times: 40, schedule: Schedule.spaced("500 millis") }),
          Effect.timeout("25 seconds"),
          Effect.mapError(
            () =>
              new CodespacesError({
                code: "bootstrap",
                message: "Codespace worker is unreachable. Reconnect this project.",
              }),
          ),
          Effect.onError(() => disconnect(space.name)),
        );
      const previewPorts = new Map<number, number>();
      const previewLocks = yield* KeyedLock.make<number>();
      const forwardPort = (remotePort: number) =>
        previewLocks.withLock(
          remotePort,
          Effect.gen(function* () {
            const existing = previewPorts.get(remotePort);
            if (existing) return existing;
            const port = yield* net.reserveLoopbackPort().pipe(
              Effect.mapError(
                () =>
                  new CodespacesError({
                    code: "bootstrap",
                    message: "Could not reserve preview port.",
                  }),
              ),
            );
            const previewScope = yield* Scope.fork(scope);
            const clearPort = Effect.sync(() => {
              if (previewPorts.get(remotePort) === port) previewPorts.delete(remotePort);
            });
            yield* Scope.addFinalizer(previewScope, clearPort);
            return yield* Effect.gen(function* () {
              const preview = yield* spawner
                .spawn(
                  ChildProcess.make(
                    "gh",
                    [
                      "codespace",
                      "ssh",
                      "--codespace",
                      space.name,
                      "--",
                      "-N",
                      "-T",
                      "-o",
                      "ExitOnForwardFailure=yes",
                      "-o",
                      "ServerAliveInterval=15",
                      "-o",
                      "ServerAliveCountMax=3",
                      "-L",
                      `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
                    ],
                    {
                      env: yield* ghEnvironment,
                      extendEnv: true,
                      stdin: { stream: Stream.empty, endOnDone: true },
                    },
                  ),
                )
                .pipe(
                  Effect.provideService(Scope.Scope, previewScope),
                  Effect.mapError(
                    () =>
                      new CodespacesError({
                        code: "bootstrap",
                        message: "Could not forward Codespace preview.",
                      }),
                  ),
                );
              yield* Stream.runDrain(preview.stdout).pipe(
                Effect.ignore,
                Effect.forkIn(previewScope),
              );
              yield* Stream.runDrain(preview.stderr).pipe(
                Effect.ignore,
                Effect.forkIn(previewScope),
              );
              yield* preview.exitCode.pipe(
                Effect.andThen(clearPort),
                Effect.ignore,
                Effect.forkIn(previewScope),
              );
              yield* net.isPortAvailableOnLoopback(port).pipe(
                Effect.flatMap((available) =>
                  available
                    ? Effect.fail(
                        new CodespacesError({
                          code: "busy",
                          message: "Opening preview connection.",
                        }),
                      )
                    : Effect.void,
                ),
                Effect.retry({ times: 40, schedule: Schedule.spaced("250 millis") }),
                Effect.mapError(
                  () =>
                    new CodespacesError({
                      code: "bootstrap",
                      message: "Codespace preview connection did not open.",
                    }),
                ),
              );
              if (
                !(yield* preview.isRunning.pipe(
                  Effect.mapError(
                    () =>
                      new CodespacesError({
                        code: "bootstrap",
                        message: "Could not check Codespace preview connection.",
                      }),
                  ),
                ))
              ) {
                return yield* new CodespacesError({
                  code: "bootstrap",
                  message: "Codespace preview connection closed.",
                });
              }
              previewPorts.set(remotePort, port);
              return port;
            }).pipe(Effect.onError(() => Scope.close(previewScope, Exit.void)));
          }),
        );
      yield* workspaces.register({
        name: space.name,
        remoteRoot: result.workspacePath,
        workerUrl: `http://127.0.0.1:${localPort}`,
        execServerUrl: `ws://127.0.0.1:${execPort}`,
        token,
        forwardPort,
        isForwardedPort: (port) => [...previewPorts.values()].includes(port),
      });
      return {
        name: space.name,
        account,
        codespaceId: space.id,
        environmentId: null,
        localPort,
        remotePort: result.workerPort,
        workspacePath: result.workspacePath,
        connected: true,
      };
    },
  );
  return CodespacesHost.of({
    connect,
    disconnect,
    pair: () =>
      Effect.fail(
        new CodespacesError({
          code: "configuration",
          message:
            "Codespaces now run from a local project. Open that project on this T3 environment; no additional environment pairing is needed.",
        }),
      ),
    prepareStop: () => Effect.void,
    rebuild: (name) =>
      Effect.gen(function* () {
        yield* processRunner
          .run({
            operation: "Codespaces.rebuild",
            command: "gh",
            args: ["codespace", "rebuild", "--codespace", name],
            cwd: config.cwd,
            env: yield* ghEnvironment,
            timeoutMs: 900_000,
          })
          .pipe(
            Effect.mapError(
              () =>
                new CodespacesError({
                  code: "github",
                  message: "GitHub could not rebuild the Codespace. Inspect its creation log.",
                }),
            ),
          );
      }),
    disconnected: SubscriptionRef.changes(exits).pipe(
      Stream.map((state) => state.name),
      Stream.filter((name) => name !== ""),
    ),
  });
});
export const layer = Layer.effect(CodespacesHost, make);
