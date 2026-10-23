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
import * as Hex from "effect/encoding/Hex";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Crypto from "effect/Crypto";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
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

const launchResult = Schema.Struct({
  workerPort: Schema.Int,
  execPort: Schema.Int,
  workspacePath: Schema.String,
});
const decodeLaunch = Schema.decodeEffect(Schema.fromJsonString(launchResult));
const decodeAttach = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ launch: launchResult, token: Schema.String })),
);
interface Forward {
  readonly local: number;
  readonly remote: number;
}
interface Transport {
  /** Runs a remote shell script and returns the last line it printed. */
  readonly exec: (
    script: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, CodespacesError>;
  /** Opens the worker forwards and returns the process whose exit ends the connection. */
  readonly open: (
    forwards: ReadonlyArray<Forward>,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, CodespacesError>;
  /** Adds a preview forward within the scope and returns the process that carries it. */
  readonly forward: (
    forward: Forward,
    scope: Scope.Scope,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, CodespacesError>;
}
const bootstrapError = (message: string) => new CodespacesError({ code: "bootstrap", message });
const setupFailed =
  "Codespace worker setup failed. Check its GitHub creation log and SSH server, then reconnect.";
const keepAlive = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
const forwardArgs = (forwards: ReadonlyArray<Forward>) =>
  forwards.flatMap(({ local, remote }) => ["-L", `127.0.0.1:${local}:127.0.0.1:${remote}`]);
const lastLine = (output: string) => output.trim().split(/\r?\n/).at(-1) ?? "";
// Prints the running worker's launch details only when this exact launcher started both processes.
const attachScript = `set -u
state="/workspaces/.t3-executors/$1"
stale() { echo stale; exit 0; }
[ "$(cat "$state/fingerprint" 2>/dev/null)" = "$2" ] || stale
[ -s "$state/launch.json" ] && [ -s "$state/token" ] || stale
for service in worker executor; do
  pid=$(cat "$state/$service.pid" 2>/dev/null) || stale
  case "$pid" in ''|*[!0-9]*) stale ;; esac
  [ -r "/proc/$pid/cmdline" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -F "$state/" >/dev/null || stale
done
printf '{"launch":%s,"token":"%s"}\\n' "$(cat "$state/launch.json")" "$(cat "$state/token")"
`;
const launcherScript = (token: string, worker: string) => `set -eu
state="/workspaces/.t3-executors/$1"
mkdir -p "$state"
chmod 700 "$state"
rm -f "$state/fingerprint" "$state/launch.json"
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
  case "$(uname -m)" in
    x86_64) target=x86_64-unknown-linux-musl; sha=9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f ;;
    aarch64|arm64) target=aarch64-unknown-linux-musl; sha=f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7 ;;
    *) exit 1 ;;
  esac
  curl -fsSL --retry 2 "https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-$target.tar.gz" -o "$state/codex.tar.gz"
  printf '%s  %s\\n' "$sha" "$state/codex.tar.gz" | sha256sum -c - >/dev/null || { echo 'codex-checksum-mismatch' >&2; exit 1; }
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
rm -f "$state/worker.log"
nohup node "$state/worker.mjs" "$workspace" "$state/token" > "$state/worker.log" 2>&1 < /dev/null &
printf '%s' "$!" > "$state/worker.pid"
launch=$(node - "$state/worker.log" "$exec_port" "$workspace" <<'NODE'
const fs=require('fs'); const [log,execPort,workspacePath]=process.argv.slice(2);
const deadline=Date.now()+30000;
const timer=setInterval(()=>{
 try { const value=JSON.parse(fs.readFileSync(log,'utf8').trim().split('\\n').at(-1)); clearInterval(timer);console.log(JSON.stringify({workerPort:value.port,execPort:Number(execPort),workspacePath})); }
 catch { if(Date.now()>deadline){clearInterval(timer);process.exit(1)} }
},100);
NODE
)
printf '%s' "$launch" > "$state/launch.json"
printf '%s' "$3" > "$state/fingerprint"
printf '%s\n' "$launch"
`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const getWorkerSource = workspaceWorkerSource.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const processRunner = yield* VcsProcess.VcsProcess;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* Net.NetService;
  const config = yield* ServerConfig.ServerConfig;
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const webSocket = yield* Socket.WebSocketConstructor;
  // A live PID can hide a stalled exec-server, so a reattached executor must finish a handshake.
  const executorReady = (port: number, token: string) =>
    Socket.makeWebSocket(`ws://127.0.0.1:${port}`, {
      openTimeout: "5 seconds",
      headers: { authorization: `Bearer ${token}` },
    }).pipe(
      Effect.flatMap((socket) => socket.reader),
      Effect.scoped,
      Effect.provideService(Socket.WebSocketConstructor, webSocket),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const workspaces = yield* CodespacesWorkspace.CodespacesWorkspace;
  const lifetime = yield* Effect.scope;
  const exits = yield* SubscriptionRef.make({ name: "", generation: 0 });
  const forwards = new Map<
    string,
    { scope: Scope.Closeable; process: ChildProcessSpawner.ChildProcessHandle }
  >();
  const ghEnvironment = Effect.gen(function* () {
    const pinned = yield* GitHubRequestPolicy.PinnedGitHubCredential;
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
  const run = Effect.fn("CodespacesHost.run")(function* (
    operation: string,
    command: string,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    return yield* processRunner.run({
      operation,
      command,
      args,
      cwd: config.cwd,
      ...(stdin === undefined ? {} : { stdin }),
      env: yield* ghEnvironment,
      timeoutMs: 900_000,
      maxOutputBytes: 100_000,
    });
  });
  const spawnSsh = Effect.fn("CodespacesHost.spawnSsh")(function* (
    command: string,
    args: ReadonlyArray<string>,
    scope: Scope.Scope,
    message: string,
  ) {
    const child = yield* spawner
      .spawn(
        ChildProcess.make(command, args, {
          env: yield* ghEnvironment,
          extendEnv: true,
          stdin: { stream: Stream.empty, endOnDone: true },
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(() => bootstrapError(message)),
      );
    yield* Stream.runDrain(child.stdout).pipe(Effect.ignore, Effect.forkIn(scope));
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkIn(scope));
    return child;
  });
  const ghSsh = (name: string, args: ReadonlyArray<string>) => [
    "codespace",
    "ssh",
    "--codespace",
    name,
    "--",
    ...args,
  ];
  // Every channel builds its own GitHub tunnel.
  const legacyTransport = (name: string, scope: Scope.Scope): Transport => ({
    exec: (script, args) =>
      run(
        "Codespaces.ssh",
        "gh",
        ghSsh(name, ["-T", "sh", "-l", "-s", "--", ...args]),
        script,
      ).pipe(
        Effect.map((output) => lastLine(output.stdout)),
        Effect.mapError(() => bootstrapError(setupFailed)),
      ),
    open: (forwards) =>
      spawnSsh(
        "gh",
        ghSsh(name, [
          "-N",
          "-T",
          "-o",
          "ExitOnForwardFailure=yes",
          ...keepAlive,
          ...forwardArgs(forwards),
        ]),
        scope,
        "Could not open the Codespace SSH connection.",
      ),
    forward: (forward, previewScope) =>
      spawnSsh(
        "gh",
        ghSsh(name, [
          "-N",
          "-T",
          "-o",
          "ExitOnForwardFailure=yes",
          ...keepAlive,
          ...forwardArgs([forward]),
        ]),
        previewScope,
        "Could not forward Codespace preview.",
      ),
  });
  const sshConfigs = new Map<string, { readonly file: string; readonly host: string }>();
  let muxDirectory: string | undefined;
  let muxFiles = 0;
  // One GitHub tunnel per connection: an OpenSSH control master behind `gh cs ssh --stdio`
  // carries setup, worker forwards and preview forwards.
  const muxTransport = Effect.fn("CodespacesHost.muxTransport")(function* (
    name: string,
    scope: Scope.Scope,
  ) {
    // Short fixed root: macOS limits control socket paths to 104 bytes.
    if (!muxDirectory)
      muxDirectory = yield* fs
        .makeTempDirectoryScoped({ directory: "/tmp", prefix: "t3cs-" })
        .pipe(Effect.provideService(Scope.Scope, lifetime));
    const directory = muxDirectory;
    let sshConfig = sshConfigs.get(name);
    if (!sshConfig) {
      const output = yield* run("Codespaces.sshConfig", "gh", [
        "codespace",
        "ssh",
        "--config",
        "--codespace",
        name,
      ]);
      const host = /^Host\s+(\S+)/m.exec(output.stdout)?.[1];
      if (!host)
        return yield* bootstrapError("GitHub returned no SSH configuration for this Codespace.");
      const file = path.join(directory, `${++muxFiles}.config`);
      yield* fs.writeFileString(file, output.stdout, { mode: 0o600 });
      sshConfig = { file, host };
      sshConfigs.set(name, sshConfig);
    }
    const { host } = sshConfig;
    const base = [
      "-F",
      sshConfig.file,
      "-o",
      `ControlPath=${path.join(directory, `${++muxFiles}.sock`)}`,
    ];
    const master = yield* spawnSsh(
      "ssh",
      [
        ...base,
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=no",
        "-N",
        "-T",
        ...keepAlive,
        host,
      ],
      scope,
      "Could not open the Codespace SSH connection.",
    );
    yield* master.isRunning.pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((running) =>
        running
          ? run("Codespaces.sshCheck", "ssh", [...base, "-O", "check", host]).pipe(
              Effect.mapError(() => "pending" as const),
            )
          : Effect.fail("closed" as const),
      ),
      Effect.retry({
        schedule: Schedule.spaced("200 millis"),
        while: (reason) => reason === "pending",
      }),
      Effect.timeout("1 minute"),
      Effect.mapError(() => bootstrapError("Could not open the Codespace SSH connection.")),
    );
    const addForwards = (forwards: ReadonlyArray<Forward>, message: string) =>
      run("Codespaces.sshForward", "ssh", [
        ...base,
        "-O",
        "forward",
        ...forwardArgs(forwards),
        host,
      ]).pipe(
        Effect.as(master),
        Effect.mapError(() => bootstrapError(message)),
      );
    return {
      exec: (script, args) =>
        run(
          "Codespaces.ssh",
          "ssh",
          [...base, "-o", "ControlMaster=no", "-T", host, "sh", "-l", "-s", "--", ...args],
          script,
        ).pipe(
          Effect.map((output) => lastLine(output.stdout)),
          Effect.mapError(() => bootstrapError(setupFailed)),
        ),
      open: (forwards) => addForwards(forwards, "Could not open the Codespace SSH connection."),
      forward: (forward, previewScope) =>
        addForwards([forward], "Could not forward Codespace preview.").pipe(
          Effect.tap(() =>
            Scope.addFinalizer(
              previewScope,
              run("Codespaces.sshCancel", "ssh", [
                ...base,
                "-O",
                "cancel",
                ...forwardArgs([forward]),
                host,
              ]).pipe(Effect.ignore),
            ),
          ),
        ),
    } satisfies Transport;
  });
  const openTransport = (name: string, scope: Scope.Scope) => {
    // Windows OpenSSH has no control master support.
    if (platform === "win32") return Effect.succeed(legacyTransport(name, scope));
    return Effect.gen(function* () {
      const muxScope = yield* Scope.fork(scope);
      return yield* muxTransport(name, muxScope).pipe(
        Effect.onError(() => Scope.close(muxScope, Exit.void)),
      );
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          // Retry sharing on the next connect; a cached configuration may be stale after a rebuild.
          sshConfigs.delete(name);
          return legacyTransport(name, scope);
        }),
      ),
    );
  };
  const disconnect = Effect.fn("CodespacesHost.disconnect")(function* (name: string) {
    yield* workspaces.disconnect(name);
    const entry = forwards.get(name);
    if (!entry) return;
    forwards.delete(name);
    yield* Scope.close(entry.scope, Exit.void);
  });
  const connectOnce = Effect.fn("CodespacesHost.connectOnce")(function* (
    space: Codespace,
    account: string,
    reuse: boolean,
  ) {
    const worker = yield* getWorkerSource;
    const fingerprint = Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(launcherScript("", worker)))
        .pipe(Effect.orDie),
    );
    const executorId = `${account}-${space.id}`;
    // Relaunch can stop the remote processes even when SSH never returns their replacements.
    yield* disconnect(space.name);
    const scope = yield* Scope.make();
    return yield* Effect.gen(function* () {
      const transport = yield* openTransport(space.name, scope);
      const attached = reuse
        ? yield* transport
            .exec(attachScript, [executorId, fingerprint])
            .pipe(Effect.flatMap(decodeAttach), Effect.option)
        : Option.none();
      const token = Option.isSome(attached)
        ? attached.value.token
        : (yield* crypto.randomUUIDv4().pipe(Effect.orDie)) +
          (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const result = Option.isSome(attached)
        ? attached.value.launch
        : yield* transport
            .exec(launcherScript(token, worker), [executorId, space.repository, fingerprint])
            .pipe(
              Effect.flatMap((line) =>
                decodeLaunch(line).pipe(
                  Effect.mapError(() =>
                    bootstrapError(
                      "Codespace worker did not report ready. Check its worker log, then reconnect.",
                    ),
                  ),
                ),
              ),
            );
      const localPort = yield* net
        .reserveLoopbackPort()
        .pipe(
          Effect.mapError(() => bootstrapError("Could not reserve a workspace forwarding port.")),
        );
      const execPort = yield* net
        .reserveLoopbackPort()
        .pipe(
          Effect.mapError(() => bootstrapError("Could not reserve an executor forwarding port.")),
        );
      const child = yield* transport.open([
        { local: localPort, remote: result.workerPort },
        { local: execPort, remote: result.execPort },
      ]);
      forwards.set(space.name, { scope, process: child });
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
      const healthy = yield* client
        .execute(
          HttpClientRequest.get(`http://127.0.0.1:${localPort}/health`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.retry({ times: 40, schedule: Schedule.spaced("500 millis") }),
          Effect.timeout(Option.isSome(attached) ? "5 seconds" : "25 seconds"),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!healthy) {
        if (Option.isNone(attached))
          return yield* bootstrapError("Codespace worker is unreachable. Reconnect this project.");
        yield* disconnect(space.name);
        return undefined;
      }
      if (Option.isSome(attached) && !(yield* executorReady(execPort, token))) {
        yield* disconnect(space.name);
        return undefined;
      }
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
              const preview = yield* transport.forward(
                { local: port, remote: remotePort },
                previewScope,
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
      if (
        forwards.get(space.name)?.process !== child ||
        !(yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))
      )
        return yield* bootstrapError(
          "Codespace SSH connection closed during workspace registration.",
        );
      return {
        name: space.name,
        account,
        codespaceId: space.id,
        environmentId: null,
        localPort,
        remotePort: result.workerPort,
        workspacePath: result.workspacePath,
        connected: true,
      } satisfies CodespacesManagedEnvironment;
    }).pipe(
      Effect.onError(() =>
        forwards.get(space.name)?.scope === scope
          ? disconnect(space.name)
          : Scope.close(scope, Exit.void),
      ),
    );
  });
  // Reattach to a healthy worker first; relaunch it when it is missing, outdated or unresponsive.
  const connect: CodespacesHost["Service"]["connect"] = Effect.fn("CodespacesHost.connect")(
    function* (space, account) {
      const attached = yield* connectOnce(space, account, true);
      if (attached) return attached;
      const launched = yield* connectOnce(space, account, false);
      if (launched) return launched;
      return yield* bootstrapError("Codespace worker is unreachable. Reconnect this project.");
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
    rebuild: Effect.fn("CodespacesHost.rebuild")(function* (name) {
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
