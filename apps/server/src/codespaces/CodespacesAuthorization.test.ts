import { expect, it } from "@effect/vitest";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { make } from "./CodespacesAuthorization.ts";

const harness = (
  options: {
    source?: "gh" | "env" | "settings";
    activeToken?: string;
    missingScopes?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const commands: ChildProcess.Command[] = [];
    let invalidations = 0;
    let closed = false;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        commands.push(command);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          // Split the code across chunks, as real subprocess pipes may do.
          stderr: Stream.make(
            new TextEncoder().encode("First copy your one-time code: ABCD-"),
            new TextEncoder().encode("1234\n"),
          ),
          all: Stream.empty,
          exitCode: Deferred.await(exit),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.mock(GitHubRest.GitHubRest)({
            rest: () =>
              Effect.succeed({
                status: 200,
                headers: options.missingScopes
                  ? {}
                  : { "x-oauth-scopes": "repo, read:org, gist, workflow" },
                body: "{}",
                truncated: false,
                invalidUtf8: false,
              }),
          }),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: () =>
              Effect.succeed({
                host: "github.com",
                source: options.source ?? "gh",
                token: Redacted.make("original-token"),
                fingerprint: "original",
              }),
            invalidate: () =>
              Effect.sync(() => {
                invalidations++;
              }),
          }),
          Layer.mock(VcsProcess.VcsProcess)({
            run: () =>
              Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: options.activeToken ?? "original-token",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          }),
        ),
      ),
    );
    const phase = (phase: string) =>
      service.changes.pipe(
        Stream.filter((state) => state.phase === phase),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    return {
      service,
      phase,
      commands,
      exit,
      invalidations: () => invalidations,
      closed: () => closed,
    };
  });

it.effect(
  "adds Codespaces scope through refresh, deduplicates sign-in, and invalidates credentials after success",
  () =>
    Effect.gen(function* () {
      const test = yield* harness();
      yield* test.service.authorize({ cancel: false });
      expect((yield* test.phase("waiting")).code).toBe("ABCD-1234");
      yield* test.service.authorize({ cancel: false });
      expect(test.commands).toHaveLength(1);
      expect(test.commands[0]).toMatchObject({
        command: "gh",
        args: [
          "auth",
          "refresh",
          "--hostname",
          "github.com",
          "--scopes",
          "repo,read:org,gist,workflow,codespace",
        ],
      });
      expect(test.invalidations()).toBe(0);
      yield* Deferred.succeed(test.exit, ChildProcessSpawner.ExitCode(0));
      expect((yield* test.phase("succeeded")).code).toBeNull();
      expect(test.invalidations()).toBe(1);
      expect(test.closed()).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect("cancel stops approval without invalidating or removing existing credentials", () =>
  Effect.gen(function* () {
    const test = yield* harness();
    yield* test.service.authorize({ cancel: false });
    yield* test.phase("waiting");
    const canceled = yield* test.service.authorize({ cancel: true });
    expect(canceled.phase).toBe("idle");
    expect(canceled.code).toBeNull();
    expect(test.closed()).toBe(true);
    expect(test.invalidations()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("failed approval keeps credentials and allows retry", () =>
  Effect.gen(function* () {
    const test = yield* harness();
    yield* test.service.authorize({ cancel: false });
    yield* test.phase("waiting");
    yield* Deferred.succeed(test.exit, ChildProcessSpawner.ExitCode(1));
    expect((yield* test.phase("failed")).message).toContain("existing GitHub access has been kept");
    expect(test.invalidations()).toBe(0);
    yield* test.service.authorize({ cancel: false });
    yield* test.phase("failed");
    expect(test.commands).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect.each(["env", "settings"] as const)(
  "keeps %s token instead of changing an unused CLI login",
  (source) =>
    Effect.gen(function* () {
      const test = yield* harness({ source });
      yield* test.service.authorize({ cancel: false });
      expect((yield* test.phase("failed")).message).toContain(
        "Add Codespaces permission to that token",
      );
      expect(test.commands).toHaveLength(0);
      expect(test.invalidations()).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("does not refresh a different active CLI account", () =>
  Effect.gen(function* () {
    const test = yield* harness({ activeToken: "another-account-token" });
    yield* test.service.authorize({ cancel: false });
    expect((yield* test.phase("failed")).message).toContain("Select the active GitHub CLI account");
    expect(test.commands).toHaveLength(0);
    expect(test.invalidations()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("refuses approval when existing scopes cannot be confirmed", () =>
  Effect.gen(function* () {
    const test = yield* harness({ missingScopes: true });
    yield* test.service.authorize({ cancel: false });
    expect((yield* test.phase("failed")).message).toContain(
      "did not report this token's existing permissions",
    );
    expect(test.commands).toHaveLength(0);
    expect(test.invalidations()).toBe(0);
  }).pipe(Effect.scoped),
);
