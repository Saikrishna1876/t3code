import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { checkUpstreamRelease } from "./upstreamRelease.ts";

it.effect(
  "selects the requested track and compares source ancestry despite independent fork versions",
  () =>
    Effect.gen(function* () {
      for (const channel of ["latest", "nightly"] as const) {
        for (const status of ["ahead", "identical", "behind", "diverged"] as const) {
          const urls: string[] = [];
          const tag = channel === "latest" ? "v0.1.10" : "v0.1.10-nightly.20261114.1";
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              urls.push(request.url);
              const body = request.url.includes("/compare/")
                ? { status }
                : channel === "latest"
                  ? { tag_name: tag, draft: false, prerelease: false }
                  : [
                      { tag_name: "v9.0.0-preview.20261114.1", draft: false, prerelease: true },
                      { tag_name: "v9.0.0", draft: false, prerelease: false },
                      { tag_name: "v9.0.0-nightly.20261114.1", draft: true, prerelease: true },
                      { tag_name: tag, draft: false, prerelease: true },
                    ];
              return HttpClientResponse.fromWeb(request, Response.json(body));
            }),
          );
          const result = yield* checkUpstreamRelease(
            "Saikrishna1876/t3code",
            "0.1.99",
            channel,
          ).pipe(Effect.provideService(HttpClient.HttpClient, client));
          assert.equal(
            result?.version,
            status === "behind" || status === "diverged" ? tag.slice(1) : undefined,
          );
          assert.equal(urls.length, 2);
          assert.ok(
            urls[1]?.endsWith(`compare/${encodeURIComponent(tag)}...Saikrishna1876%3Av0.1.99`),
          );
        }
      }
    }),
);

it.effect("looks past stable-only pages for nightly and skips upstream installations", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url);
        const body = request.url.includes("/compare/")
          ? { status: "behind" }
          : request.url.endsWith("page=1")
            ? Array.from({ length: 100 }, () => ({
                tag_name: "v0.1.9",
                draft: false,
                prerelease: false,
              }))
            : [{ tag_name: "v0.1.10-nightly.20261114.1", draft: false, prerelease: true }];
        return HttpClientResponse.fromWeb(request, Response.json(body));
      }),
    );
    const run = (repository: string) =>
      checkUpstreamRelease(repository, "0.1.99", "nightly").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
    assert.equal(yield* run("pingdotgg/t3code"), undefined);
    assert.equal(urls.length, 0);
    assert.equal((yield* run("Saikrishna1876/t3code"))?.version, "0.1.10-nightly.20261114.1");
    assert.equal(urls.length, 3);
  }),
);
