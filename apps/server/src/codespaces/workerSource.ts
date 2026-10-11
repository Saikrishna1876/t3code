import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CodespacesError } from "@t3tools/contracts";
declare const __T3CODE_WORKSPACE_WORKER__: string;
export const workspaceWorkerSource = Effect.gen(function* () {
  if (typeof __T3CODE_WORKSPACE_WORKER__ !== "undefined") return __T3CODE_WORKSPACE_WORKER__;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workerPath = yield* path
    .fromFileUrl(new URL("../../dist-workspace/worker.mjs", import.meta.url))
    .pipe(
      Effect.mapError(
        () =>
          new CodespacesError({
            code: "configuration",
            message: "Could not resolve the workspace worker path.",
          }),
      ),
    );
  return yield* fs.readFileString(workerPath).pipe(
    Effect.mapError(
      () =>
        new CodespacesError({
          code: "configuration",
          message:
            "Build the workspace worker with node apps/server/scripts/build-workspace-worker.ts, then reconnect.",
        }),
    ),
  );
});
