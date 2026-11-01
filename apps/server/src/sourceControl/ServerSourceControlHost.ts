import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as CodespacesWorkspace from "../codespaces/CodespacesWorkspace.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const process = yield* VcsProcess.VcsProcess;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const secrets = yield* SecretResolver.SecretResolver;
  const workspace = Option.getOrUndefined(
    yield* Effect.serviceOption(CodespacesWorkspace.CodespacesWorkspace),
  );
  return SourceControlHost.SourceControlHost.of({
    settings: {
      get: serverSettings.getSettings,
      getWithSecrets: (kind) =>
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) =>
            resolveSourceControlHostSecrets(secrets, settings.sourceControlHosts, kind).pipe(
              Effect.map((sourceControlHosts) =>
                sourceControlHosts === settings.sourceControlHosts
                  ? settings
                  : { ...settings, sourceControlHosts },
              ),
            ),
          ),
        ),
      update: serverSettings.updateSettings,
    },
    process: {
      run: Effect.fn("ServerSourceControlHost.run")(function* (input) {
        const target = workspace ? yield* workspace.lookup(input.cwd) : null;
        if (!target) return yield* process.run(input);
        if (input.command === "git" && workspace)
          return yield* workspace
            .call<SourceControlHost.SourceControlProcessOutput>(input.cwd, "vcs", "execute", [
              input,
            ])
            .pipe(
              Effect.mapError((cause) =>
                cause._tag === "CodespacesError"
                  ? new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause,
                    })
                  : cause,
              ),
            );
        return yield* process.run({ ...input, spawnCwd: target.hostRoot ?? target.localRoot });
      }),
    },
    git: {
      execute: git.execute,
      resolveCommit: git.resolveCommit,
      remotes: (cwd) =>
        vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
      readConfigValue: git.readConfigValue,
      resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
      ensureRemote: git.ensureRemote,
      listLocalBranchNames: git.listLocalBranchNames,
      fetchRemoteBranch: git.fetchRemoteBranch,
      fetchRemoteTrackingBranch: git.fetchRemoteTrackingBranch,
      setBranchUpstream: git.setBranchUpstream,
      createBranch: git.createBranch,
      writeConfigValue: git.writeConfigValue,
      switchRef: git.switchRef,
    },
  });
});

export const layer = Layer.effect(SourceControlHost.SourceControlHost, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);
