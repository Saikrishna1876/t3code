import { assert, it } from "@effect/vitest";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CodespacesWorkspace from "../codespaces/CodespacesWorkspace.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

it.effect(
  "resolves remote worktree repositories while keeping authenticated CLIs on the host",
  () =>
    Effect.gen(function* () {
      const host = yield* SourceControlHost.SourceControlHost;
      const cwd = "/host/project/.git/t3-codespaces/space/.git/t3-worktrees/project/feature";
      const remote = yield* host.process.run({
        operation: "repository",
        command: "git",
        args: ["remote", "-v"],
        cwd,
      });
      assert.equal(remote.stdout, "git@github.com:remote/repo.git\n");
      const account = yield* host.process.run({
        operation: "account",
        command: "gh",
        args: ["auth", "status"],
        cwd,
      });
      assert.equal(account.stdout, "host-account\n");
    }).pipe(
      Effect.provide(
        Layer.effect(SourceControlHost.SourceControlHost, ServerSourceControlHost.make).pipe(
          Layer.provide(Settings.layerTest()),
          Layer.provide(
            Layer.mock(SecretResolver.SecretResolver)({
              read: () => Effect.succeed([]),
              invalidate: () => Effect.void,
            }),
          ),
          Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              execute: () => Effect.succeed(processOutput("git@github.com:remote/repo.git\n")),
            }),
          ),
          Layer.provide(
            Layer.mock(VcsProcess.VcsProcess)({
              run: (input) =>
                (input.spawnCwd ?? input.cwd) === "/host/project"
                  ? Effect.succeed(
                      processOutput(
                        input.command === "git"
                          ? "git@github.com:local/repo.git\n"
                          : "host-account\n",
                      ),
                    )
                  : Effect.fail(
                      new VcsProcessSpawnError({
                        operation: input.operation,
                        command: input.command,
                        cwd: input.cwd,
                        cause: new Error("Virtual host worktree does not exist"),
                      }),
                    ),
            }),
          ),
          Layer.provide(
            Layer.mock(CodespacesWorkspace.CodespacesWorkspace)({
              lookup: () =>
                Effect.succeed({
                  hostRoot: "/host/project",
                  localRoot: "/host/project/.git/t3-codespaces/space",
                } as never),
              call: () =>
                Effect.succeed(processOutput("git@github.com:remote/repo.git\n")) as never,
            }),
          ),
        ),
      ),
    ),
);
