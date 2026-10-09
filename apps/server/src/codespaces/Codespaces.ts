import * as TerminalManager from "../terminal/Manager.ts";
import * as FileSystem from "effect/FileSystem";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import { ProjectId, type CodespacesProject } from "@t3tools/contracts";
import {
  Codespace,
  CodespacesConfiguration,
  CodespacesError,
  CodespacesManagedEnvironment,
  CodespacesOperation,
  CodespacesSnapshot,
  type CodespacesOptions,
  CodespacesRunInput,
  type CodespacesPairResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schedule from "effect/Schedule";
import * as DateTime from "effect/DateTime";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as CodespacesHost from "./CodespacesHost.ts";

export class Codespaces extends Context.Service<
  Codespaces,
  {
    readonly project: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<CodespacesProject, CodespacesError>;
    readonly bind: (input: {
      projectId: ProjectId;
      name: string | null;
    }) => Effect.Effect<CodespacesProject, CodespacesError>;
    readonly list: Effect.Effect<
      { account: string; codespaces: ReadonlyArray<Codespace> },
      CodespacesError
    >;
    readonly options: (input: {
      repository: string;
      ref?: string;
    }) => Effect.Effect<CodespacesOptions, CodespacesError>;
    readonly snapshot: Effect.Effect<CodespacesSnapshot>;
    readonly configure: (
      configuration: CodespacesConfiguration,
    ) => Effect.Effect<CodespacesSnapshot, CodespacesError>;
    readonly run: (
      input: CodespacesRunInput,
      callerProjectId?: ProjectId,
    ) => Effect.Effect<CodespacesOperation, CodespacesError>;
    readonly pair: (input: {
      name: string;
      remote: boolean;
    }) => Effect.Effect<CodespacesPairResult, CodespacesError>;
    readonly changes: Stream.Stream<CodespacesSnapshot, CodespacesError>;
  }
>()("t3/codespaces/Codespaces") {}

const emptyConfiguration: CodespacesConfiguration = {
  releaseBaseUrl: "",
  archiveVersion: "",
  remoteScriptPath: "",
  publicUrlTemplate: "",
  networkAccess: false,
  agentAccessEnabled: false,
};
const RawCodespace = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  repository: Schema.Struct({ full_name: Schema.String }),
  git_status: Schema.Struct({ ref: Schema.String }),
  state: Schema.String,
  machine: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  web_url: Schema.String,
  idle_timeout_minutes: Schema.NullOr(Schema.Int),
  retention_period_minutes: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
const normalize = (space: typeof RawCodespace.Type): Codespace => ({
  id: space.id,
  name: space.name,
  displayName: space.display_name ?? space.name,
  repository: space.repository.full_name,
  branch: space.git_status.ref,
  state: space.state,
  machine: space.machine?.name ?? "",
  webUrl: space.web_url,
  idleTimeoutMinutes: space.idle_timeout_minutes,
  retentionMinutes: space.retention_period_minutes ?? null,
});
const Store = Schema.Struct({
  configuration: CodespacesConfiguration,
  operations: Schema.Array(CodespacesOperation),
  environments: Schema.Array(CodespacesManagedEnvironment),
  requests: Schema.Record(Schema.String, Schema.String),
});
const error = (code: CodespacesError["code"], message: string) =>
  new CodespacesError({ code, message });
const decodeStore = Schema.decodeEffect(Schema.fromJsonString(Store));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(Store));
const encodeRequestKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ account: Schema.String, input: CodespacesRunInput })),
);
const isCodespacesError = Schema.is(CodespacesError);
const decodeAccount = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);
const decodeCodespace = Schema.decodeEffect(Schema.fromJsonString(RawCodespace));
const decodeInventory = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ codespaces: Schema.Array(RawCodespace) })),
);
const decodeMachines = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      machines: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          display_name: Schema.String,
          cpus: Schema.Int,
          memory_in_bytes: Schema.Number,
        }),
      ),
    }),
  ),
);
const decodeDevcontainers = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      devcontainers: Schema.Array(
        Schema.Struct({ path: Schema.String, name: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
);
const decodeRepository = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Int })),
);
const invalidGitHubResponse = () =>
  error("github", "GitHub returned an invalid Codespaces response.");
export function validateCodespacesConfiguration(configuration: CodespacesConfiguration) {
  if (
    configuration.remoteScriptPath &&
    (!configuration.remoteScriptPath.startsWith("/") ||
      /[\r\n\0]/.test(configuration.remoteScriptPath))
  )
    throw new Error("Remote server script must be an absolute path.");
  if (
    configuration.archiveVersion &&
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(configuration.archiveVersion)
  )
    throw new Error("Use an exact server release version.");
  if (configuration.releaseBaseUrl) {
    const url = new URL(configuration.releaseBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error(
        "Use a fork-owned HTTPS release-download URL without credentials or query parameters.",
      );
  }
  if (configuration.publicUrlTemplate) {
    const url = new URL(
      configuration.publicUrlTemplate
        .replaceAll("{name}", "codespace")
        .replaceAll("{port}", "12345"),
    );
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("Remote access requires an HTTPS origin without a path or credentials.");
  }
  return configuration;
}
const make = Effect.gen(function* () {
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const workspaces = yield* CodespacesWorkspace.CodespacesWorkspace;
  const fs = yield* FileSystem.FileSystem;
  const terminals = Option.getOrUndefined(
    yield* Effect.serviceOption(TerminalManager.TerminalManager),
  );
  const closeProjectTerminals = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if (!terminals) return;
      const snapshot = yield* projections
        .getShellSnapshot()
        .pipe(Effect.mapError(() => error("storage", "Could not inspect project terminals.")));
      for (const thread of snapshot.threads)
        if (thread.projectId === projectId)
          yield* terminals
            .close({ threadId: thread.id })
            .pipe(
              Effect.mapError(() =>
                error("conflict", "Close project terminals before switching its execution target."),
              ),
            );
    });
  const exists = (path: string) =>
    fs
      .exists(path)
      .pipe(
        Effect.mapError(() =>
          error("configuration", "Could not inspect this project’s dev-container configuration."),
        ),
      );
  const process = yield* VcsProcess.VcsProcess;
  const projectRoot = (projectId: ProjectId) =>
    projectStore.get(projectId).pipe(
      Effect.mapError(() => error("storage", "Could not read this project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(error("configuration", "Project no longer exists.")),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );
  const assertIdle = (projectId: ProjectId) =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(() => error("storage", "Could not inspect project work.")),
      Effect.flatMap((snapshot) =>
        snapshot.threads.some(
          (thread) =>
            thread.projectId === projectId &&
            (["running", "waiting"].includes(thread.status) ||
              ["running", "preparing", "starting", "waiting"].includes(
                thread.activityRunStatus ?? "",
              ) ||
              thread.pendingRuntimeRequest != null),
        )
          ? Effect.fail(
              error(
                "conflict",
                "Stop active turns in this project before switching or stopping its Codespace.",
              ),
            )
          : Effect.void,
      ),
    );
  const project = Effect.fn("Codespaces.project")(function* (input: { projectId: ProjectId }) {
    const root = yield* projectRoot(input.projectId);
    const folder = root + "/.devcontainer";
    const paths: string[] = [];
    if (yield* exists(folder + "/devcontainer.json")) paths.push(".devcontainer/devcontainer.json");
    if (yield* exists(folder)) {
      for (const name of yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))) {
        const directory = yield* fs.stat(folder + "/" + name).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (directory && (yield* exists(folder + "/" + name + "/devcontainer.json")))
          paths.push(".devcontainer/" + name + "/devcontainer.json");
      }
    }
    const git = (args: readonly string[]) =>
      process
        .run({
          operation: "Codespaces.project",
          command: "git",
          args,
          cwd: root,
          maxOutputBytes: 4096,
        })
        .pipe(
          Effect.map((value) => value.stdout.trim()),
          Effect.orElseSucceed(() => ""),
        );
    const origin = yield* git(["remote", "get-url", "origin"]);
    const match = /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin);
    const repository = match?.[1] ?? "";
    const ref = yield* git(["symbolic-ref", "--short", "HEAD"]);
    const target = yield* workspaces.lookup(root);
    const eligible = paths.length > 0 && repository !== "" && ref !== "";
    return {
      projectId: input.projectId,
      eligible,
      reason: !paths.length
        ? "Add a .devcontainer/devcontainer.json to this project first."
        : !repository
          ? "This project needs a GitHub origin remote."
          : !ref
            ? "Check out a branch before creating a Codespace."
            : "",
      repository,
      ref,
      devcontainerPaths: paths,
      name: target?.name ?? null,
      connected: target?.executor !== null && target?.executor !== undefined,
    };
  });
  const bind = Effect.fn("Codespaces.bind")(function* (input: {
    projectId: ProjectId;
    name: string | null;
  }) {
    yield* assertIdle(input.projectId);
    const root = yield* projectRoot(input.projectId);
    if (input.name === null) {
      yield* closeProjectTerminals(input.projectId);
      yield* workspaces.bind({ projectId: input.projectId, name: null });
    } else {
      const info = yield* project(input);
      if (!info.eligible) return yield* error("configuration", info.reason);
      const inventory = yield* pinned(list);
      const space = inventory.codespaces.find((space) => space.name === input.name);
      if (
        !space ||
        space.repository.toLowerCase() !== info.repository.toLowerCase() ||
        space.branch !== info.ref
      )
        return yield* error(
          "configuration",
          "Choose a Codespace for this project's repository and branch.",
        );
      yield* closeProjectTerminals(input.projectId);
      yield* workspaces.bind({ projectId: input.projectId, localRoot: root, name: input.name });
    }
    return yield* project(input);
  });
  const api = yield* GitHubApi.GitHubApi;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const pinned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const credential = yield* credentials
        .get("github.com")
        .pipe(
          Effect.mapError(() =>
            error(
              "authentication",
              "Sign in to GitHub on this controller with the codespace scope.",
            ),
          ),
        );
      return yield* Effect.provideService(effect, GitHubApi.PinnedGitHubCredential, {
        host: "github.com",
        token: credential.token,
        credentialFingerprint: credential.fingerprint,
      });
    });
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const host = yield* CodespacesHost.CodespacesHost;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const initial = yield* secrets.get("codespaces-controller-v1").pipe(
    Effect.mapError(() => error("storage", "Could not read Codespaces controller state.")),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed({
            configuration: emptyConfiguration,
            operations: [] as CodespacesOperation[],
            environments: [] as CodespacesManagedEnvironment[],
            requests: {} as Record<string, string>,
          }),
        onSome: (bytes) =>
          decodeStore(new TextDecoder().decode(bytes)).pipe(
            Effect.mapError(() =>
              error(
                "storage",
                "Codespaces controller state is invalid; it was preserved for recovery.",
              ),
            ),
          ),
      }),
    ),
  );
  const state = yield* SubscriptionRef.make<typeof initial>({
    ...initial,
    environments: initial.environments.map((environment) => ({ ...environment, connected: false })),
    operations: initial.operations.map((operation): CodespacesOperation =>
      operation.status === "running"
        ? {
            ...operation,
            status: "failed",
            stage: "interrupted",
            message:
              "Controller restarted during this operation. Refresh GitHub and reconnect any workspace already created; this request will not be replayed.",
          }
        : operation,
    ),
  });
  const persist = (next: typeof initial) =>
    encodeStore(next).pipe(
      Effect.flatMap((json) =>
        secrets.set("codespaces-controller-v1", new TextEncoder().encode(json)),
      ),
      Effect.mapError(() => error("storage", "Could not persist Codespaces controller state.")),
      Effect.andThen(SubscriptionRef.set(state, next)),
    );
  const update = (f: (current: typeof initial) => typeof initial) =>
    mutex.withPermits(1)(
      SubscriptionRef.get(state).pipe(Effect.flatMap((current) => persist(f(current)))),
    );
  // Persist the recovery markers before admitting new requests.
  yield* persist(yield* SubscriptionRef.get(state));
  const account = api
    .rest({ host: "github.com", operation: "Codespaces.account", path: "user" })
    .pipe(
      Effect.mapError(mapGitHubError),
      Effect.flatMap((response) =>
        decodeAccount(response.body).pipe(Effect.mapError(invalidGitHubResponse)),
      ),
      Effect.map((user) => user.login),
      Effect.tap((login) =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const stale = current.environments.filter(
            (environment) => environment.connected && environment.account !== login,
          );
          if (!stale.length) return;
          for (const environment of stale) yield* host.disconnect(environment.name);
          yield* update((value) => ({
            ...value,
            environments: value.environments.map((environment) =>
              environment.account !== login ? { ...environment, connected: false } : environment,
            ),
          }));
        }),
      ),
    );
  const rest = (
    path: string,
    method: GitHubApi.GitHubRestInput["method"] = "GET",
    body?: unknown,
  ) =>
    api
      .rest({
        host: "github.com",
        operation: `Codespaces.${method}`,
        path,
        method,
        ...(body === undefined ? {} : { body }),
        maxResponseBytes: 2_000_000,
      })
      .pipe(Effect.mapError(mapGitHubError));
  const get = (name: string) =>
    rest(`user/codespaces/${encodeURIComponent(name)}`).pipe(
      Effect.flatMap((response) =>
        decodeCodespace(response.body).pipe(Effect.mapError(invalidGitHubResponse)),
      ),
      Effect.map(normalize),
    );
  const list = Effect.gen(function* () {
    const login = yield* account;
    const spaces: Codespace[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = yield* rest(`user/codespaces?per_page=100&page=${page}`);
      const decoded = yield* decodeInventory(response.body).pipe(
        Effect.mapError(invalidGitHubResponse),
      );
      spaces.push(...decoded.codespaces.map(normalize));
      if (decoded.codespaces.length < 100) return { account: login, codespaces: spaces };
    }
    return yield* error(
      "github",
      "Codespaces listing exceeded 100 pages. Narrow the GitHub account's workspace list.",
    );
  });
  const options = Effect.fn("Codespaces.options")(function* (input: {
    repository: string;
    ref?: string;
  }) {
    const path = input.repository.split("/").map(encodeURIComponent).join("/");
    const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
    const [machinesResponse, containersResponse] = yield* Effect.all(
      [
        rest(`repos/${path}/codespaces/machines${query}`),
        rest(`repos/${path}/codespaces/devcontainers${query}`),
      ],
      { concurrency: 2 },
    );
    const machines = yield* decodeMachines(machinesResponse.body).pipe(
      Effect.mapError(invalidGitHubResponse),
    );
    const containers = yield* decodeDevcontainers(containersResponse.body).pipe(
      Effect.mapError(invalidGitHubResponse),
    );
    return {
      machines: machines.machines.map((machine) => ({
        name: machine.name,
        displayName: machine.display_name,
        cpus: machine.cpus,
        memoryBytes: machine.memory_in_bytes,
      })),
      devcontainers: containers.devcontainers.map((container) => ({
        path: container.path,
        name: container.name ?? container.path,
      })),
    };
  });
  const configure = (configuration: CodespacesConfiguration) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateCodespacesConfiguration(configuration),
        catch: (cause) =>
          error(
            "configuration",
            cause instanceof Error ? cause.message : "Invalid Codespaces configuration.",
          ),
      });
      yield* update((current) => ({ ...current, configuration }));
      return yield* SubscriptionRef.get(state);
    });
  const stage = (id: string, nextStage: string, message: string, name?: string) =>
    update((current) => ({
      ...current,
      operations: current.operations.map((operation) =>
        operation.clientRequestId === id
          ? { ...operation, stage: nextStage, message, ...(name ? { name } : {}) }
          : operation,
      ),
    }));
  const awaitAvailable = (name: string) =>
    get(name).pipe(
      Effect.flatMap((space) =>
        space.state === "Available"
          ? Effect.succeed(space)
          : ["Failed", "Deleted", "Archived"].includes(space.state)
            ? Effect.fail(
                error(
                  "github",
                  `Codespace is ${space.state}. Open its GitHub logs before retrying.`,
                ),
              )
            : Effect.fail(error("busy", `Codespace is ${space.state}.`)),
      ),
      Effect.retry({
        times: 180,
        schedule: Schedule.spaced("2 seconds"),
        while: (cause) => cause.code === "busy",
      }),
      Effect.timeout("7 minutes"),
      Effect.mapError((cause) =>
        isCodespacesError(cause)
          ? cause
          : error(
              "github",
              "Codespace did not become available. Refresh its GitHub status before retrying.",
            ),
      ),
    );
  const perform = Effect.fn("Codespaces.perform")(function* (
    input: CodespacesRunInput,
    login: string,
    configuration: CodespacesConfiguration,
  ) {
    let name = input.action === "create" ? "" : input.name;
    if (input.projectId) yield* assertIdle(input.projectId);
    if (input.action === "create") {
      yield* stage(input.clientRequestId, "creating", "Creating a Codespace in GitHub.");
      const repository = yield* rest(`repos/${input.repository}`).pipe(
        Effect.flatMap((response) =>
          decodeRepository(response.body).pipe(Effect.mapError(invalidGitHubResponse)),
        ),
      );
      const result = yield* rest("user/codespaces", "POST", {
        repository_id: repository.id,
        ...(input.ref ? { ref: input.ref } : {}),
        machine: input.machine,
        ...(input.devcontainerPath ? { devcontainer_path: input.devcontainerPath } : {}),
        idle_timeout_minutes: input.idleTimeoutMinutes,
        retention_period_minutes: input.retentionDays * 1440,
        display_name: `T3 ${input.clientRequestId.slice(0, 36)}`,
        multi_repo_permissions_opt_out: true,
      }).pipe(
        Effect.flatMap((response) =>
          decodeCodespace(response.body).pipe(Effect.mapError(invalidGitHubResponse)),
        ),
      );
      name = result.name;
      yield* stage(input.clientRequestId, "starting", "Waiting for the Codespace to start.", name);
    }
    if (input.projectId && ["create", "start", "connect", "rebuild"].includes(input.action)) {
      // GitHub creation can take long enough for new local work to start.
      yield* assertIdle(input.projectId);
      const localRoot = yield* projectRoot(input.projectId);
      yield* closeProjectTerminals(input.projectId);
      yield* workspaces.bind({ projectId: input.projectId, localRoot, name });
    }
    let space = yield* get(name);
    const previous = (yield* SubscriptionRef.get(state)).environments.find(
      (entry) => entry.name === name && entry.account === login,
    );
    if (["stop", "delete", "rebuild"].includes(input.action)) {
      if (space.state !== "Shutdown") {
        if (!previous && !("force" in input && input.force))
          return yield* error(
            "conflict",
            "Connect this Codespace before inspecting work, or explicitly force the operation.",
          );
        if (previous)
          yield* host.prepareStop(
            previous,
            configuration,
            "force" in input && Boolean(input.force),
          );
      }
      yield* stage(
        input.clientRequestId,
        input.action === "stop"
          ? "stopping"
          : input.action === "delete"
            ? "deleting"
            : "rebuilding",
        `Requesting ${input.action} from GitHub.`,
      );
      if (input.action === "rebuild") yield* host.rebuild(name);
      else
        yield* rest(
          `user/codespaces/${name}${input.action === "delete" ? "" : "/stop"}`,
          input.action === "delete" ? "DELETE" : "POST",
        );
      yield* host.disconnect(name);
      if (input.action === "delete") {
        for (const binding of yield* workspaces.bindings)
          if (binding.name === name)
            yield* workspaces.bind({ projectId: binding.projectId, name: null });
      }
      yield* update((value) => ({
        ...value,
        environments:
          input.action === "delete"
            ? value.environments.filter((entry) => entry.name !== name)
            : value.environments.map((entry) =>
                entry.name === name ? { ...entry, connected: false } : entry,
              ),
      }));
      if (input.action === "stop")
        yield* get(name).pipe(
          Effect.flatMap((value) =>
            value.state === "Shutdown"
              ? Effect.void
              : Effect.fail(error("busy", "Waiting for GitHub shutdown.")),
          ),
          Effect.retry({
            times: 180,
            schedule: Schedule.spaced("2 seconds"),
            while: (cause) => cause.code === "busy",
          }),
          Effect.timeout("7 minutes"),
          Effect.mapError(() =>
            error(
              "github",
              "GitHub has not confirmed shutdown yet. Refresh its status before retrying.",
            ),
          ),
        );
      if (input.action !== "rebuild") return;
    }
    if (input.action === "update") {
      if (input.machine && space.state !== "Shutdown")
        return yield* error("conflict", "Stop this Codespace before changing its machine.");
      if (!input.displayName && !input.machine)
        return yield* error("configuration", "Choose a display name or machine to update.");
      yield* rest(`user/codespaces/${name}`, "PATCH", {
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.machine ? { machine: input.machine } : {}),
      });
      return;
    }
    space = yield* get(name);
    if (space.state === "Shutdown" && input.action === "connect")
      return yield* error(
        "conflict",
        "This Codespace is stopped. Use Start and connect to resume compute.",
      );
    if (space.state === "Shutdown") {
      yield* stage(input.clientRequestId, "starting", "Starting this Codespace.");
      yield* rest(`user/codespaces/${name}/start`, "POST");
    }
    space = yield* awaitAvailable(name);
    yield* stage(
      input.clientRequestId,
      "bootstrapping",
      "Preparing workspace tools and opening the SSH connection. Your agent and login stay here.",
    );
    const environment = yield* host.connect(space, login, configuration, previous);
    yield* update((value) => ({
      ...value,
      environments: [
        ...value.environments.filter((entry) => entry.name !== name || entry.account !== login),
        environment,
      ],
    }));
  });
  const run = Effect.fn("Codespaces.run")(function* (
    input: CodespacesRunInput,
    callerProjectId?: ProjectId,
  ) {
    if (callerProjectId && "name" in input) {
      const bindings = yield* workspaces.bindings;
      if (
        !bindings.some(
          (binding) => binding.name === input.name && binding.projectId === callerProjectId,
        )
      )
        return yield* error(
          "permission",
          "Thread callers can manage only their project’s bound Codespace.",
        );
    }
    if (input.action === "create" || ["start", "connect", "rebuild"].includes(input.action)) {
      if (!input.projectId)
        return yield* error("configuration", "Start Codespaces from an existing project.");
      const info = yield* project({ projectId: input.projectId });
      if (!info.eligible) return yield* error("configuration", info.reason);
      if (input.action === "create") {
        if (input.repository !== info.repository || input.ref !== info.ref)
          return yield* error(
            "configuration",
            "Codespace repository and branch must match this project.",
          );
        if (!input.devcontainerPath || !info.devcontainerPaths.includes(input.devcontainerPath))
          return yield* error(
            "configuration",
            "Choose a .devcontainer configuration from this project.",
          );
        const remoteOptions = yield* options({ repository: info.repository, ref: info.ref });
        if (
          !remoteOptions.devcontainers.some(
            (container) => container.path === input.devcontainerPath,
          )
        )
          return yield* error(
            "configuration",
            "Push this dev-container configuration to GitHub before creating a Codespace.",
          );
      } else {
        const space = yield* get(input.name);
        if (
          space.repository.toLowerCase() !== info.repository.toLowerCase() ||
          space.branch !== info.ref
        )
          return yield* error(
            "configuration",
            "Codespace repository and branch must match this project.",
          );
      }
      yield* assertIdle(input.projectId);
    }
    if (["stop", "delete", "rebuild"].includes(input.action) && "name" in input) {
      for (const binding of yield* workspaces.bindings)
        if (binding.name === input.name) yield* assertIdle(ProjectId.make(binding.projectId));
    }
    const login = yield* account;
    const requestKey = yield* encodeRequestKey({ account: login, input }).pipe(Effect.orDie);
    const accepted = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const existing = current.operations.find(
          (operation) => operation.clientRequestId === input.clientRequestId,
        );
        if (existing) {
          if (current.requests[input.clientRequestId] !== requestKey)
            return yield* error(
              "conflict",
              "This request ID belongs to a different Codespaces operation or GitHub account.",
            );
          return { operation: existing, start: false, configuration: current.configuration };
        }
        if (
          current.operations.some(
            (operation) =>
              operation.status === "running" &&
              (input.action === "create"
                ? operation.action === "create"
                : operation.name === input.name),
          )
        )
          return yield* error("busy", "A Codespaces operation is already running for this target.");
        const operation: CodespacesOperation = {
          ...(input.projectId ? { projectId: input.projectId } : {}),
          clientRequestId: input.clientRequestId,
          action: input.action,
          name: input.action === "create" ? null : input.name,
          status: "running",
          stage: "accepted",
          message: "Operation accepted by this controller.",
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* persist({
          ...current,
          requests: { ...current.requests, [input.clientRequestId]: requestKey },
          operations: [...current.operations, operation],
        });
        return { operation, start: true, configuration: current.configuration };
      }),
    );
    if (!accepted.start) return accepted.operation;
    yield* perform(input, login, accepted.configuration).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          update((current) => ({
            ...current,
            operations: current.operations.map((operation) =>
              operation.clientRequestId === input.clientRequestId
                ? { ...operation, status: "failed", message: cause.message }
                : operation,
            ),
          })),
        onSuccess: () =>
          update((current) => ({
            ...current,
            operations: current.operations.map((operation) =>
              operation.clientRequestId === input.clientRequestId
                ? {
                    ...operation,
                    status: "succeeded",
                    stage: "complete",
                    message:
                      input.action === "stop"
                        ? "Codespace stopped. Storage remains billable until deletion."
                        : "Operation completed.",
                  }
                : operation,
            ),
          })),
      }),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    return accepted.operation;
  });
  const pair = (input: { name: string; remote: boolean }) =>
    Effect.gen(function* () {
      const login = yield* account;
      const current = yield* SubscriptionRef.get(state);
      const environment = current.environments.find(
        (entry) => entry.name === input.name && entry.account === login,
      );
      if (!environment)
        return yield* error("configuration", "Connect this Codespace before pairing it.");
      return yield* host.pair(environment, current.configuration, input.remote);
    });
  yield* host.disconnected.pipe(
    Stream.runForEach((name) =>
      update((current) => ({
        ...current,
        environments: current.environments.map((entry) =>
          entry.name === name ? { ...entry, connected: false } : entry,
        ),
      })).pipe(Effect.ignore),
    ),
    forkParked,
  );
  // Restore forwards only for this account's already-running Codespaces.
  yield* pinned(
    Effect.gen(function* () {
      const login = yield* account;
      const timestamp = DateTime.toEpochMillis(yield* DateTime.now);
      for (const environment of initial.environments) {
        if (environment.account !== login) continue;
        const binding = (yield* workspaces.bindings).find(
          (entry) => entry.name === environment.name,
        );
        if (!binding) continue;
        const space = yield* get(environment.name).pipe(Effect.option);
        if (Option.isSome(space) && space.value.state === "Available")
          yield* run({
            action: "connect",
            projectId: ProjectId.make(binding.projectId),
            name: environment.name,
            clientRequestId: `restore-${timestamp}-${environment.codespaceId}`,
          }).pipe(Effect.ignore);
      }
    }),
  ).pipe(Effect.ignore, forkParked);
  return Codespaces.of({
    project,
    bind,
    snapshot: SubscriptionRef.get(state).pipe(
      Effect.map(({ requests: _requests, ...snapshot }) => snapshot),
    ),
    list: pinned(list),
    options: (input) => pinned(options(input)),
    configure,
    run: (input, callerProjectId) => pinned(run(input, callerProjectId)),
    pair: (input) => pinned(pair(input)),
    changes: SubscriptionRef.changes(state).pipe(
      Stream.map(({ requests: _requests, ...snapshot }) => snapshot),
    ),
  });
});
export function mapGitHubError(cause: GitHubApi.GitHubApiError): CodespacesError {
  switch (cause._tag) {
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
      return error(
        "authentication",
        "Sign in to GitHub on this controller with the codespace scope.",
      );
    case "GitHubApiResponseError":
      return cause.status === 403
        ? error(
            "permission",
            "GitHub denied Codespaces access. Check codespace scope, repository access and organization policy.",
          )
        : cause.status === 402
          ? error("quota", "GitHub requires billing or additional Codespaces quota.")
          : error("github", `GitHub rejected this Codespaces operation with HTTP ${cause.status}.`);
    default:
      return error(
        "github",
        "GitHub Codespaces request failed. Check network access, account permissions and GitHub status.",
      );
  }
}
export const layer = Layer.effect(Codespaces, make);
