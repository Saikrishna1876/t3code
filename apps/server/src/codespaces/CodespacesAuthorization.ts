import { CodespacesError, type CodespacesAuthorization } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const isCodespacesError = Schema.is(CodespacesError);

/** Adds scopes through gh's refresh flow. Login and scope removal are deliberately absent. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const process = yield* VcsProcess.VcsProcess;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<CodespacesAuthorization>({
    phase: "idle",
    code: null,
    message: "",
  });
  let active: Fiber.Fiber<void> | undefined;
  const set = (value: CodespacesAuthorization) => SubscriptionRef.set(state, value);
  const refresh = Effect.gen(function* () {
    const credential = yield* credentials.get("github.com");
    if (credential.source !== "gh") {
      return yield* new CodespacesError({
        code: "permission",
        message:
          "GitHub uses a token from Settings or the server environment. Add Codespaces permission to that token, then refresh status. Your existing token has been kept.",
      });
    }
    const current = yield* process.run({
      operation: "CodespacesAuthorization.account",
      command: "gh",
      args: ["auth", "token", "--hostname", "github.com"],
      cwd: globalThis.process.cwd(),
      env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
    });
    if (current.stdout.trim() !== Redacted.value(credential.token)) {
      return yield* new CodespacesError({
        code: "permission",
        message:
          "Select the active GitHub CLI account in Source Control settings before adding Codespaces permission. Your existing accounts have been kept.",
      });
    }
    const response = yield* api
      .rest({
        host: "github.com",
        operation: "CodespacesAuthorization.scopes",
        path: "user",
      })
      .pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "github.com",
          token: credential.token,
          credentialFingerprint: credential.fingerprint,
        }),
      );
    const previousScopes = response.headers["x-oauth-scopes"];
    if (previousScopes === undefined) {
      return yield* new CodespacesError({
        code: "permission",
        message:
          "GitHub did not report this token's existing permissions. Update its Codespaces access manually, then refresh status. Your existing token has been kept.",
      });
    }
    // gh tolerates a failed scope lookup. Pass every current scope explicitly so that failure
    // cannot replace a broad token with one granting only Codespaces and gh's minimum scopes.
    const scopes = [
      ...new Set([
        ...previousScopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
        "codespace",
      ]),
    ];
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "gh",
        ["auth", "refresh", "--hostname", "github.com", "--scopes", scopes.join(",")],
        {
          env: { GH_BROWSER: "echo", GH_DEBUG: "", GH_PROMPT_DISABLED: "" },
          extendEnv: true,
          stdin: { stream: Stream.make(new TextEncoder().encode("\n")), endOnDone: true },
        },
      ),
    );
    const decoder = new TextDecoder();
    let output = "";
    const readCode = Stream.runForEach(child.stderr, (chunk) => {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-8192);
      const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output)?.[0];
      return code
        ? set({
            phase: "waiting",
            code,
            message:
              "Enter this code on GitHub to add Codespaces permission. Existing permissions are kept.",
          })
        : Effect.void;
    });
    const [exitCode] = yield* Effect.all(
      [child.exitCode, readCode, Stream.runDrain(child.stdout)],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new CodespacesError({
        code: "authentication",
        message:
          "GitHub permission approval failed or expired. Retry sign-in. Your existing GitHub access has been kept.",
      });
    }
  }).pipe(
    Effect.scoped,
    Effect.andThen(credentials.invalidate("github.com")),
    Effect.andThen(
      set({
        phase: "succeeded",
        code: null,
        message: "GitHub permissions updated. Existing permissions were kept.",
      }),
    ),
    Effect.timeout("16 minutes"),
    Effect.catch((cause) =>
      set({
        phase: "failed",
        code: null,
        message: isCodespacesError(cause)
          ? cause.message
          : "Could not update GitHub permissions. Check GitHub CLI on your T3 host, then retry. Existing access has been kept.",
      }),
    ),
  );
  return {
    snapshot: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    authorize: (input: { cancel: boolean }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (input.cancel) {
            if (active) yield* Fiber.interrupt(active);
            active = undefined;
            yield* set({
              phase: "idle",
              code: null,
              message: "Sign-in canceled. Existing GitHub access has been kept.",
            });
          } else {
            const current = yield* SubscriptionRef.get(state);
            if (current.phase === "starting" || current.phase === "waiting") return current;
            yield* set({
              phase: "starting",
              code: null,
              message: "Requesting additional GitHub permission…",
            });
            active = yield* refresh.pipe(Effect.forkIn(scope));
          }
          return yield* SubscriptionRef.get(state);
        }),
      ),
  };
});
