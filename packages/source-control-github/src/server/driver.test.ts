import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { makeWithSharedServices } from "./driver.ts";

it.effect(
  "shares Codespaces quota observations and credential invalidation with the driver",
  () => {
    let tokenReads = 0;
    let requests = 0;
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ title: "Issue", body: null }), {
              headers: {
                "content-type": "application/json",
                "x-ratelimit-resource": "core",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "499",
                "x-ratelimit-reset": "600",
              },
            }),
          ),
        );
      }),
    );
    const services = GitHubRest.layerWithDependencies.pipe(
      Layer.provideMerge(SourceControlRateLimit.layer),
      Layer.provideMerge(http),
      Layer.provideMerge(
        TestSourceControlHost.layer({
          process: {
            run: () =>
              Effect.sync(() => TestSourceControlHost.processOutput(`token-${++tokenReads}`)),
          },
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const api = yield* GitHubRest.GitHubRest;
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      yield* api.rest({ host: "github.com", operation: "codespaces", path: "user/codespaces" });
      const driver = yield* makeWithSharedServices;
      const read = driver.sourceControl.resolveLink?.({
        cwd: "/workspace",
        url: new URL("https://github.com/acme/web/issues/1"),
      });
      if (!read) return yield* Effect.die("GitHub issue links must resolve");
      const error = yield* Effect.flip(read);
      expect(error).toMatchObject({ cause: { _tag: "SourceControlRateLimitPausedError" } });
      expect(requests).toBe(1);
      expect(tokenReads).toBe(1);

      yield* credentials.invalidate("github.com");
      expect(yield* read).toEqual({ title: "Issue", body: null });
      expect(requests).toBe(2);
      expect(tokenReads).toBe(2);
    }).pipe(
      Effect.provide(Layer.merge(services, NodeServices.layer)),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    );
  },
);
