// @effect-diagnostics nodeBuiltinImport:off -- mapping needs both Windows host and POSIX remote path semantics.
import {
  CodespacesError,
  VcsError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProjectWriteFileInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { makeWorkspaceReservations } from "./WorkspaceReservations.ts";
import * as NodePath from "node:path";

export interface WorkspaceExecutor {
  readonly name: string;
  readonly remoteRoot: string;
  readonly workerUrl: string;
  readonly execServerUrl: string;
  readonly token: string;
  readonly forwardPort?: (port: number) => Effect.Effect<number, CodespacesError>;
  readonly isForwardedPort?: (port: number) => boolean;
}
const Binding = Schema.Struct({
  projectId: Schema.String,
  localRoot: Schema.String,
  name: Schema.String,
});
export type WorkspaceBinding = typeof Binding.Type;

/** Explicit project bindings. An unavailable bound executor always fails; it never falls back locally. */
export class CodespacesWorkspace extends Context.Service<
  CodespacesWorkspace,
  {
    readonly bindings: Effect.Effect<ReadonlyArray<WorkspaceBinding>>;
    readonly bind: (
      binding: WorkspaceBinding | { projectId: string; name: null },
      reservationId?: string,
    ) => Effect.Effect<void, CodespacesError>;
    readonly reserve: (input: {
      id: string;
      projectId?: string;
      name?: string;
      extend?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>, CodespacesError, Scope.Scope>;
    readonly acquireWork: (projectId: string) => Effect.Effect<void, CodespacesError, Scope.Scope>;
    readonly wasRemote: (cwd: string) => Effect.Effect<boolean>;
    readonly register: (executor: WorkspaceExecutor) => Effect.Effect<void>;
    readonly disconnect: (name: string) => Effect.Effect<void>;
    readonly lookup: (
      cwd: string,
    ) => Effect.Effect<
      (WorkspaceBinding & { executor: WorkspaceExecutor | null; remoteCwd: string | null }) | null
    >;
    readonly stageAttachment: (input: {
      cwd: string;
      path: string;
    }) => Effect.Effect<string, CodespacesError>;
    readonly openAsset: (input: {
      cwd: string;
      relativePath: string;
      name: string;
      offset: number;
      size: number;
    }) => Effect.Effect<Stream.Stream<Uint8Array, CodespacesError>, CodespacesError>;
    readonly call: <A>(
      cwd: string,
      group: string,
      method: string,
      args: ReadonlyArray<unknown>,
    ) => Effect.Effect<A, CodespacesError | VcsError>;
  }
>()("t3/codespaces/CodespacesWorkspace") {}

function workspacePathApi(root: string) {
  return /^[a-zA-Z]:[\\/]|^\\\\|^\/\//.test(root) ? NodePath.win32 : NodePath.posix;
}

// Remote roots are POSIX even when the controller stores Windows project paths.
function workspaceRelativePath(value: string, root: string): string | null {
  const path = workspacePathApi(root);
  if (!path.isAbsolute(value)) return null;
  const relative = path.relative(root, value);
  return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
    ? null
    : relative;
}

export function isWorkspacePath(value: string, root: string): boolean {
  return workspaceRelativePath(value, root) !== null;
}

function mapWorkspacePath(value: string, from: string, to: string): string {
  const relative = workspaceRelativePath(value, from);
  if (relative === null) return value;
  return relative === ""
    ? to
    : workspacePathApi(to).join(to, ...relative.split(workspacePathApi(from).sep));
}

export function mapWorkspacePaths(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapWorkspacePaths(item, from, to));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "string"
          ? /^(cwd|path|relativePath|partialPath|fullPath|parentPath|workspaceRoot|worktreePath|repoRoot|repositoryRoot)$/.test(
              key,
            )
            ? mapWorkspacePath(item, from, to)
            : item
          : key === "filePaths" && Array.isArray(item)
            ? item.map((path) =>
                typeof path === "string" ? mapWorkspacePath(path, from, to) : path,
              )
            : mapWorkspacePaths(item, from, to),
      ]),
    );
  return value;
}
const BindingsJson = Schema.fromJsonString(Schema.Array(Binding));
const HistoryJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeBindings = Schema.decodeEffect(BindingsJson);
const encodeBindings = Schema.encodeEffect(BindingsJson);
const decodeHistory = Schema.decodeEffect(HistoryJson);
const encodeHistory = Schema.encodeEffect(HistoryJson);
const decodeVcsError = Schema.decodeUnknownEffect(Schema.toCodecJson(VcsError));
const decodeWriteFile = Schema.decodeUnknownEffect(ProjectWriteFileInput);
const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const mutex = yield* Semaphore.make(1);
  const fs = yield* FileSystem.FileSystem;
  const saved = yield* secrets.get("codespaces-project-bindings-v1").pipe(
    Effect.mapError(
      () =>
        new CodespacesError({
          code: "storage",
          message: "Could not read Codespace project bindings.",
        }),
    ),
  );
  let bindings = Option.isSome(saved)
    ? yield* decodeBindings(new TextDecoder().decode(saved.value)).pipe(
        Effect.mapError(
          () =>
            new CodespacesError({
              code: "storage",
              message: "Codespace project bindings are invalid and were preserved.",
            }),
        ),
      )
    : [];
  const savedHistory = yield* secrets.get("codespaces-workspace-history-v1").pipe(
    Effect.mapError(
      () =>
        new CodespacesError({
          code: "storage",
          message: "Could not read workspace execution history.",
        }),
    ),
  );
  let remoteRoots = Option.isSome(savedHistory)
    ? yield* decodeHistory(new TextDecoder().decode(savedHistory.value)).pipe(
        Effect.mapError(
          () =>
            new CodespacesError({
              code: "storage",
              message: "Workspace execution history is invalid and was preserved.",
            }),
        ),
      )
    : bindings.map((binding) => binding.localRoot);
  // Git canonicalizes paths, while project records may retain symlink spellings such as /tmp.
  const canonicalRoots = new Map<string, string>();
  const rememberRoot = (root: string) =>
    fs.realPath(root).pipe(
      Effect.orElseSucceed(() => root),
      Effect.tap((canonical) => Effect.sync(() => canonicalRoots.set(root, canonical))),
    );
  yield* Effect.forEach(remoteRoots, rememberRoot);
  const executors = new Map<string, WorkspaceExecutor>();
  const reservations = makeWorkspaceReservations();
  const lookup = (cwd: string) =>
    Effect.sync(() => {
      const match = bindings
        .flatMap((binding) =>
          [binding.localRoot, canonicalRoots.get(binding.localRoot) ?? binding.localRoot]
            .filter((root) => workspaceRelativePath(cwd, root) !== null)
            .map((root) => ({ binding, root })),
        )
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (!match) return null;
      const executor = executors.get(match.binding.name) ?? null;
      return {
        ...match.binding,
        localRoot: match.root,
        executor,
        remoteCwd: executor ? mapWorkspacePath(cwd, match.root, executor.remoteRoot) : null,
      };
    });
  return CodespacesWorkspace.of({
    reserve: (input) =>
      mutex.withPermits(1)(
        Effect.suspend(() => {
          const names = new Set(input.name ? [input.name] : []);
          for (const binding of bindings)
            if (binding.projectId === input.projectId) names.add(binding.name);
          const projectIds = new Set(input.projectId ? [input.projectId] : []);
          for (const binding of bindings)
            if (names.has(binding.name)) projectIds.add(binding.projectId);
          return reservations
            .reserve(input.id, [...projectIds], [...names], input.extend)
            .pipe(Effect.as([...projectIds]));
        }),
      ),
    acquireWork: reservations.acquireWork,
    bindings: Effect.sync(() => bindings),
    wasRemote: (cwd) =>
      Effect.sync(() =>
        remoteRoots.some((root) =>
          [root, canonicalRoots.get(root) ?? root].some(
            (alias) => workspaceRelativePath(cwd, alias) !== null,
          ),
        ),
      ),
    bind: (binding, reservationId) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* reservations.assertBindingAvailable(
            binding.projectId,
            binding.name,
            reservationId,
          );
          if (binding.name !== null && !remoteRoots.includes(binding.localRoot)) {
            const nextRoots = [...remoteRoots, binding.localRoot];
            const history = yield* encodeHistory(nextRoots).pipe(Effect.orDie);
            yield* secrets
              .set("codespaces-workspace-history-v1", new TextEncoder().encode(history))
              .pipe(
                Effect.mapError(
                  () =>
                    new CodespacesError({
                      code: "storage",
                      message: "Could not save workspace execution history.",
                    }),
                ),
              );
            remoteRoots = nextRoots;
          }
          const next = [
            ...bindings.filter((item) => item.projectId !== binding.projectId),
            ...(binding.name === null ? [] : [binding]),
          ];
          const encoded = yield* encodeBindings(next).pipe(Effect.orDie);
          yield* secrets
            .set("codespaces-project-bindings-v1", new TextEncoder().encode(encoded))
            .pipe(
              Effect.mapError(
                () =>
                  new CodespacesError({
                    code: "storage",
                    message: "Could not save Codespace project binding.",
                  }),
              ),
            );
          bindings = next;
          if (binding.name !== null) yield* rememberRoot(binding.localRoot);
        }),
      ),
    register: (executor) =>
      Effect.sync(() => {
        executors.set(executor.name, executor);
      }),
    disconnect: (name) =>
      Effect.sync(() => {
        executors.delete(name);
      }),
    lookup,
    stageAttachment: ({ cwd, path: attachmentPath }) =>
      Effect.gen(function* () {
        const target = yield* lookup(cwd);
        if (!target?.executor)
          return yield* new CodespacesError({
            code: "conflict",
            message: "Resume the Codespace before sending attachments.",
          });
        const info = yield* fs.stat(attachmentPath).pipe(
          Effect.mapError(
            () =>
              new CodespacesError({
                code: "configuration",
                message: "Could not inspect the attached file.",
              }),
          ),
        );
        if (info.type !== "File" || info.size > BigInt(PROVIDER_SEND_TURN_MAX_FILE_BYTES))
          return yield* new CodespacesError({
            code: "configuration",
            message: "Attachment is too large or is not a regular file.",
          });
        const response = yield* client
          .execute(
            HttpClientRequest.post(
              target.executor.workerUrl +
                "/attachments/" +
                encodeURIComponent(attachmentPath.replaceAll("\\", "/").split("/").at(-1)!),
            ).pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${target.executor.token}`),
              HttpClientRequest.bodyStream(fs.stream(attachmentPath), {
                contentLength: Number(info.size),
              }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              Effect.gen(function* () {
                if (response.status === 507)
                  return yield* new CodespacesError({
                    code: "storage",
                    message:
                      "Codespace attachment storage is full. Remove unused remote attachments or choose another Codespace.",
                  });
                return yield* HttpClientResponse.filterStatusOk(response);
              }),
            ),
            Effect.flatMap((response) => response.json),
            Effect.timeout("5 minutes"),
            Effect.mapError((cause) =>
              cause._tag === "CodespacesError"
                ? cause
                : new CodespacesError({
                    code: "bootstrap",
                    message: "Could not send attachment to the Codespace.",
                  }),
            ),
          );
        if (
          !response ||
          typeof response !== "object" ||
          !("path" in response) ||
          typeof response.path !== "string"
        )
          return yield* new CodespacesError({
            code: "bootstrap",
            message: "Codespace returned an invalid attachment path.",
          });
        return response.path;
      }),
    openAsset: (input) =>
      Effect.gen(function* () {
        const target = yield* lookup(input.cwd);
        if (!target?.executor || target.name !== input.name)
          return yield* new CodespacesError({
            code: "conflict",
            message: "Codespace asset is unavailable. Reopen its preview after reconnecting.",
          });
        return yield* client
          .execute(
            HttpClientRequest.post(target.executor.workerUrl + "/asset").pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${target.executor.token}`),
              HttpClientRequest.bodyJsonUnsafe({ ...input, cwd: target.remoteCwd }),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.timeout("30 seconds"),
            Effect.map((response) =>
              response.stream.pipe(
                Stream.mapError(
                  () =>
                    new CodespacesError({
                      code: "bootstrap",
                      message: "Codespace asset stream failed.",
                    }),
                ),
              ),
            ),
            Effect.mapError(
              () =>
                new CodespacesError({
                  code: "bootstrap",
                  message: "Could not read the Codespace asset.",
                }),
            ),
          );
      }),
    call: <A>(cwd: string, group: string, method: string, args: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const target = yield* lookup(cwd);
        if (!target?.executor)
          return yield* new CodespacesError({
            code: "conflict",
            message: "Codespace is disconnected. Resume it from this project before continuing.",
          });
        const executor = target.executor;
        const remoteArgs = args.map((argument, index) => {
          if (index === 0 && typeof argument === "string")
            return mapWorkspacePath(argument, target.localRoot, executor.remoteRoot);
          if (
            index === 1 &&
            Array.isArray(argument) &&
            ((group === "git" && method === "prepareCommitContext") ||
              (group === "vcs" && method === "filterIgnoredPaths"))
          )
            return argument.map((path) =>
              typeof path === "string"
                ? mapWorkspacePath(path, target.localRoot, executor.remoteRoot)
                : path,
            );
          return mapWorkspacePaths(argument, target.localRoot, executor.remoteRoot);
        });
        const request = yield* Effect.gen(function* () {
          if (group !== "files" || method !== "writeFile")
            return HttpClientRequest.post(executor.workerUrl + "/call").pipe(
              HttpClientRequest.bodyJsonUnsafe({ group, method, args: remoteArgs }),
            );
          const input = yield* decodeWriteFile(remoteArgs[0]).pipe(
            Effect.mapError(
              () =>
                new CodespacesError({
                  code: "configuration",
                  message: "Invalid workspace file write.",
                }),
            ),
          );
          // File contents bypass the bounded JSON control endpoint and its escaping overhead.
          return HttpClientRequest.post(executor.workerUrl + "/files/write").pipe(
            HttpClientRequest.setUrlParam("cwd", input.cwd),
            HttpClientRequest.setUrlParam("relativePath", input.relativePath),
            HttpClientRequest.bodyText(input.contents),
          );
        });
        const response = yield* client
          .execute(
            request.pipe(HttpClientRequest.setHeader("authorization", `Bearer ${executor.token}`)),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.json),
            Effect.timeout("5 minutes"),
            Effect.mapError(
              () =>
                new CodespacesError({
                  code: "bootstrap",
                  message: "Codespace workspace request failed. Reconnect this project and retry.",
                }),
            ),
          );
        if (typeof response !== "object" || response === null)
          return yield* new CodespacesError({
            code: "bootstrap",
            message: "Codespace returned an invalid workspace response.",
          });
        if ("error" in response)
          return yield* decodeVcsError(response.error).pipe(
            Effect.flatMap(Effect.fail),
            Effect.catchIf(
              (error) => error._tag === "SchemaError",
              () =>
                Effect.fail(
                  new CodespacesError({
                    code: "bootstrap",
                    message: "Codespace returned an invalid workspace error.",
                  }),
                ),
            ),
          );
        if (!("value" in response))
          return yield* new CodespacesError({
            code: "bootstrap",
            message: "Codespace returned no workspace result.",
          });
        // File contents and patches are opaque. Only structured Git paths are mapped for local thread bindings.
        if (group === "git" && method === "listWorktreePaths" && Array.isArray(response.value))
          return response.value.map((path) =>
            typeof path === "string"
              ? mapWorkspacePath(path, executor.remoteRoot, target.localRoot)
              : path,
          ) as A;
        return (
          group === "files" || typeof response.value === "string"
            ? response.value
            : mapWorkspacePaths(response.value, executor.remoteRoot, target.localRoot)
        ) as A;
      }),
  });
});
export const layer = Layer.effect(CodespacesWorkspace, make);

/** Adapter for existing typed workspace ports; local mode keeps exactly the original implementation. */
export function routeWorkspaceMethods<T extends object, E extends { readonly _tag: string }>(
  local: T,
  remote: CodespacesWorkspace["Service"] | undefined,
  group: string,
  failure: (cause: CodespacesError | VcsError, method: string, cwd: string) => E,
): T {
  if (!remote) return local;
  return Object.fromEntries(
    Object.entries(local).map(([method, value]) => [
      method,
      typeof value !== "function"
        ? value
        : (...args: unknown[]) =>
            Effect.gen(function* () {
              const first = args[0];
              const cwd =
                typeof first === "string"
                  ? first
                  : first &&
                      typeof first === "object" &&
                      "cwd" in first &&
                      typeof first.cwd === "string"
                    ? first.cwd
                    : null;
              const target = cwd === null ? null : yield* remote.lookup(cwd);
              if (target === null)
                return yield* (value as (...args: unknown[]) => Effect.Effect<unknown, E>)(...args);
              return yield* remote
                .call(cwd!, group, method, args)
                .pipe(Effect.mapError((cause) => failure(cause, method, cwd!)));
            }),
    ]),
  ) as T;
}
