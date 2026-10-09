import { CodespacesError, VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

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
    ) => Effect.Effect<void, CodespacesError>;
    readonly wasRemote: (cwd: string) => Effect.Effect<boolean>;
    readonly register: (executor: WorkspaceExecutor) => Effect.Effect<void>;
    readonly disconnect: (name: string) => Effect.Effect<void>;
    readonly lookup: (
      cwd: string,
    ) => Effect.Effect<
      (WorkspaceBinding & { executor: WorkspaceExecutor | null; remoteCwd: string | null }) | null
    >;
    readonly call: <A>(
      cwd: string,
      group: string,
      method: string,
      args: ReadonlyArray<unknown>,
    ) => Effect.Effect<A, CodespacesError | VcsError>;
  }
>()("t3/codespaces/CodespacesWorkspace") {}

export function mapWorkspacePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string")
    return value === from || value.startsWith(from + "/") ? to + value.slice(from.length) : value;
  if (Array.isArray(value)) return value.map((item) => mapWorkspacePaths(item, from, to));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "string"
          ? /^(cwd|path|fullPath|parentPath|workspaceRoot|worktreePath|repoRoot|repositoryRoot)$/.test(
              key,
            )
            ? mapWorkspacePaths(item, from, to)
            : item
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
  const lookup = (cwd: string) =>
    Effect.sync(() => {
      const match = bindings
        .flatMap((binding) =>
          [binding.localRoot, canonicalRoots.get(binding.localRoot) ?? binding.localRoot]
            .filter((root) => cwd === root || cwd.startsWith(root + "/"))
            .map((root) => ({ binding, root })),
        )
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (!match) return null;
      const executor = executors.get(match.binding.name) ?? null;
      return {
        ...match.binding,
        localRoot: match.root,
        executor,
        remoteCwd: executor ? executor.remoteRoot + cwd.slice(match.root.length) : null,
      };
    });
  return CodespacesWorkspace.of({
    bindings: Effect.sync(() => bindings),
    wasRemote: (cwd) =>
      Effect.sync(() =>
        remoteRoots.some((root) =>
          [root, canonicalRoots.get(root) ?? root].some(
            (alias) => cwd === alias || cwd.startsWith(alias + "/"),
          ),
        ),
      ),
    bind: (binding) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
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
    call: <A>(cwd: string, group: string, method: string, args: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const target = yield* lookup(cwd);
        if (!target?.executor)
          return yield* new CodespacesError({
            code: "conflict",
            message: "Codespace is disconnected. Resume it from this project before continuing.",
          });
        const executor = target.executor;
        const response = yield* client
          .execute(
            HttpClientRequest.post(executor.workerUrl + "/call").pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${executor.token}`),
              HttpClientRequest.bodyJsonUnsafe({
                group,
                method,
                args: mapWorkspacePaths(args, target.localRoot, executor.remoteRoot),
              }),
            ),
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
