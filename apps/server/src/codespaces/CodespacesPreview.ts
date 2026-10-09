import { CodespacesError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Workspace from "./CodespacesWorkspace.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export class CodespacesPreview extends Context.Service<
  CodespacesPreview,
  {
    readonly resolve: (threadId: ThreadId, url: string) => Effect.Effect<string, CodespacesError>;
    readonly workspaceUrl: (threadId: ThreadId, url: string) => Effect.Effect<string>;
  }
>()("t3/codespaces/CodespacesPreview") {}

export const layer = Layer.effect(
  CodespacesPreview,
  Effect.gen(function* () {
    const workspaces = yield* Workspace.CodespacesWorkspace;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const threads = yield* ProjectionStore.ProjectionStoreV2;
    // The browser reports forwarded URLs. Keep their application origins across controller reconnects.
    const origins = new Map<string, string>();
    const key = (threadId: ThreadId, url: URL) =>
      `${threadId}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
    const workspaceUrl = (threadId: ThreadId, input: string) =>
      Effect.sync(() => {
        try {
          const url = new URL(input);
          if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return input;
          const origin = origins.get(key(threadId, url));
          if (!origin) return input;
          const original = new URL(origin);
          url.protocol = original.protocol;
          url.hostname = original.hostname;
          url.port = original.port;
          return url.href;
        } catch {
          return input;
        }
      });
    return CodespacesPreview.of({
      workspaceUrl,
      resolve: (threadId, input) =>
        Effect.gen(function* () {
          const original = yield* workspaceUrl(threadId, input);
          const url = yield* Effect.try({
            try: () => new URL(original),
            catch: () =>
              new CodespacesError({ code: "configuration", message: "Invalid preview URL." }),
          });
          if (
            !["http:", "https:"].includes(url.protocol) ||
            !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          )
            return input;
          const thread = yield* threads.getThreadShell(threadId).pipe(
            Effect.mapError(
              () =>
                new CodespacesError({
                  code: "storage",
                  message: "Could not resolve preview project.",
                }),
            ),
          );
          if (!thread) return input;
          const project = yield* projects.get(thread.projectId).pipe(
            Effect.mapError(
              () =>
                new CodespacesError({
                  code: "storage",
                  message: "Could not resolve preview project.",
                }),
            ),
          );
          if (Option.isNone(project)) return input;
          const target = yield* workspaces.lookup(project.value.workspaceRoot);
          if (!target) return input;
          if (!target.executor?.forwardPort)
            return yield* new CodespacesError({
              code: "conflict",
              message: "Resume this project's Codespace before opening its preview.",
            });
          // Unrecognized active forwards can come from another tab in the same project.
          if (
            target.executor.isForwardedPort?.(
              Number(url.port || (url.protocol === "https:" ? 443 : 80)),
            )
          )
            return input;
          const port = yield* target.executor.forwardPort(
            Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          );
          const originalOrigin = url.origin;
          url.hostname = "127.0.0.1";
          url.port = String(port);
          origins.set(key(threadId, url), originalOrigin);
          return url.href;
        }),
    });
  }),
);
