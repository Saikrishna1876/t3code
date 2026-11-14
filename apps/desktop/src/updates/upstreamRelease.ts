import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});
const Comparison = Schema.Struct({
  status: Schema.Literals(["ahead", "behind", "identical", "diverged"]),
});
const UPSTREAM = "pingdotgg/t3code";
const STABLE = /^v\d+\.\d+\.\d+$/;
const NIGHTLY = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

export const checkUpstreamRelease = Effect.fn("desktop.updates.checkUpstreamRelease")(function* (
  repository: string,
  currentVersion: string,
  channel: DesktopUpdateChannel,
) {
  if (repository.toLowerCase() === UPSTREAM || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    return undefined;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const read = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
    client
      .get(`https://api.github.com/repos/${UPSTREAM}/${path}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "T3-Code-updater" },
      })
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      );

  let release: typeof Release.Type | undefined;
  if (channel === "latest") {
    const latest = yield* read("releases/latest", Release);
    if (!latest.draft && !latest.prerelease && STABLE.test(latest.tag_name)) release = latest;
  } else {
    // Stable releases can fill a page; keep looking until GitHub exhausts the release list.
    for (let page = 1; release === undefined; page++) {
      const releases = yield* read(`releases?per_page=100&page=${page}`, Schema.Array(Release));
      release = releases
        .filter((item) => !item.draft && item.prerelease && NIGHTLY.test(item.tag_name))
        .sort((a, b) => compareSemverVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
      if (releases.length < 100) break;
    }
  }
  if (!release) return undefined;
  const [owner] = repository.split("/");
  // Fork build numbers are independent; ancestry tells whether this build contains the upstream release.
  const comparison = yield* read(
    `compare/${encodeURIComponent(release.tag_name)}...${encodeURIComponent(`${owner}:v${currentVersion}`)}`,
    Comparison,
  );
  if (comparison.status === "ahead" || comparison.status === "identical") return undefined;
  return {
    version: release.tag_name.slice(1),
    url: `https://github.com/${UPSTREAM}/releases/tag/${encodeURIComponent(release.tag_name)}`,
  };
});
