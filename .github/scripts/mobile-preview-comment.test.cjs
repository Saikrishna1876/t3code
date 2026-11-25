const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");

const { main, mergeState, readState, render } = require("./mobile-preview-comment.cjs");

const fingerprint = "c31608b37a8a2dca35ccee39cfd2ec7305042629";
const run = "https://github.com/pingdotgg/t3code/actions/runs/1";

test("the comment round-trips its state", () => {
  const state = {
    android: { fingerprint, client: "", group: "8e413a0a" },
    ios: { fingerprint: "ios-fingerprint", client: "https://expo.dev/ios", group: "ios-group" },
  };
  const body = render(state, run);
  assert.deepEqual(readState(body), state);
  assert.match(body, /Client unavailable/);
  assert.match(body, /groupId=8e413a0a/);
  assert.match(body, /groupId=ios-group/);
  assert.match(body, /\[Install\]\(https:\/\/expo.dev\/ios\)/);
  assert.equal(readState("🚀 Expo continuous deployment is ready!"), null);
});

test("the build job adds the install link without losing the update", () => {
  const first = mergeState(null, { fingerprint, client: "", group: "8e413a0a" });
  const built = mergeState(first, { fingerprint, client: "https://expo.dev/a/b", group: "" });
  assert.deepEqual(built, { fingerprint, client: "https://expo.dev/a/b", group: "8e413a0a" });
  assert.match(
    render({ android: built }, run),
    /Dev client \| \[Install\]\(https:\/\/expo\.dev\/a\/b\)/,
  );
});

test("only a successful publication changes the fingerprint and client", () => {
  const built = { fingerprint, client: "https://expo.dev/a/b", group: "old" };
  assert.equal(mergeState(null, { fingerprint, client: "", group: "" }), null);
  assert.deepEqual(
    mergeState(built, { fingerprint: "f".repeat(40), client: "", group: "" }),
    built,
  );
  assert.deepEqual(mergeState(built, { fingerprint, client: "", group: "new" }), {
    fingerprint,
    client: "https://expo.dev/a/b",
    group: "new",
  });
  assert.deepEqual(mergeState(built, { fingerprint: "f".repeat(40), client: "", group: "new" }), {
    fingerprint: "f".repeat(40),
    client: "",
    group: "new",
  });
});

test("a build that finishes after the PR moved to another fingerprint changes nothing", () => {
  const current = { fingerprint: "f".repeat(40), client: "", group: "new" };
  assert.deepEqual(
    mergeState(current, { fingerprint, client: "https://expo.dev/a/b", group: "" }),
    current,
  );
});

test("state from the comment is always three strings", () => {
  assert.deepEqual(
    readState('<!-- mobile-preview-android {"fingerprint":5,"client":null} -->\nx'),
    { android: { fingerprint: "", client: "", group: "" } },
  );
});

test("publishing consolidates platform comments and preserves unrelated comments", async () => {
  const android = { fingerprint, client: "https://expo.dev/android", group: "android-group" };
  const ios = {
    fingerprint: "ios-fingerprint",
    client: "https://expo.dev/ios",
    group: "ios-group",
  };
  const comments = new Map([
    [
      1,
      {
        id: 1,
        user: { login: "github-actions[bot]" },
        body: `<!-- mobile-preview-android ${JSON.stringify(android)} -->`,
      },
    ],
    [
      2,
      {
        id: 2,
        user: { login: "github-actions[bot]" },
        body: `<!-- mobile-preview-ios ${JSON.stringify(ios)} -->`,
      },
    ],
    [
      4,
      {
        id: 4,
        user: { login: "github-actions[bot]" },
        body: "<!-- continuous-deploy-fingerprint-projectId:d763fcb8-d37c-41ea-a773-b54a0ab4a454 -->\nOld Expo preview",
      },
    ],
    [
      3,
      {
        id: 3,
        user: { login: "contributor" },
        body: `<!-- mobile-preview-ios ${JSON.stringify(ios)} -->`,
      },
    ],
  ]);
  await main({
    env: {
      GITHUB_REPOSITORY: "pingdotgg/t3code",
      PR: "1",
      GH_TOKEN: "test",
      ANDROID_FINGERPRINT: fingerprint,
      ANDROID_GROUP: "new-group",
      PR_HEAD_SHA: "current-head",
    },
    request: async (path, init = {}) => {
      if (path.endsWith("/pulls/1")) return { head: { sha: "current-head" } };
      if (!init.method) return [...comments.values()];
      const id = Number(path.split("/").at(-1));
      if (init.method === "DELETE") comments.delete(id);
      else if (init.method === "PATCH") comments.get(id).body = JSON.parse(init.body).body;
      else assert.fail("an existing preview should be reused");
    },
  });
  assert.equal(comments.size, 2);
  assert.deepEqual(readState(comments.get(1).body), {
    android: { ...android, group: "new-group" },
    ios,
  });
  assert.equal(comments.has(2), false);
  assert.equal(comments.has(4), false);
  assert.equal(comments.get(3).user.login, "contributor");
  await main({
    env: {
      GITHUB_REPOSITORY: "pingdotgg/t3code",
      PR: "1",
      GH_TOKEN: "test",
      PR_HEAD_SHA: "old-head",
      ANDROID_FINGERPRINT: fingerprint,
      ANDROID_GROUP: "stale-group",
      ANDROID_CLIENT: "https://expo.dev/older-build",
    },
    request: async (path, init = {}) => {
      if (path.endsWith("/pulls/1")) return { head: { sha: "current-head" } };
      if (!init.method) return [...comments.values()];
      assert.equal(init.method, "PATCH");
      comments.get(1).body = JSON.parse(init.body).body;
    },
  });
  assert.deepEqual(readState(comments.get(1).body).android, {
    fingerprint,
    client: "https://expo.dev/older-build",
    group: "new-group",
  });
  await main({
    env: {
      GITHUB_REPOSITORY: "pingdotgg/t3code",
      PR: "1",
      GH_TOKEN: "test",
      ANDROID_FINGERPRINT: fingerprint,
      PR_HEAD_SHA: "old-head",
      ANDROID_GROUP: "stale-group",
    },
    request: async (path) => {
      assert.equal(path, "/repos/pingdotgg/t3code/pulls/1");
      return { head: { sha: "new-head" } };
    },
  });
});

test("preview comments serialize trusted writers without granting build jobs comment access", () => {
  for (const name of ["mobile-eas-preview", "mobile-eas-preview-fork"]) {
    const workflow = readFileSync(join(__dirname, `../workflows/${name}.yml`), "utf8");
    const [jobs, writer] = workflow.split("  comment:\n");
    const builds = jobs.slice(jobs.indexOf(name.endsWith("-fork") ? "  preview:\n" : "  ios:\n"));
    assert.doesNotMatch(builds, /pull-requests: write/);
    assert.doesNotMatch(builds, /^    env:\n(?:      .*\n)*      GH_TOKEN:/m);
    if (name.endsWith("-fork")) {
      assert.match(jobs, /^  request:\n[\s\S]*?^      pull-requests: write$/m);
      assert.match(builds, /^    needs: request$/m);
      assert.doesNotMatch(builds, /issues.removeLabel/);
    }
    assert.match(
      writer,
      /group: mobile-preview-comment-\$\{\{ github.event.pull_request.number \}\}/,
    );
    assert.match(writer, /cancel-in-progress: false/);
    assert.match(writer, /queue: max/);
    assert.match(writer, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
    assert.doesNotMatch(writer, /pnpm|eas build|eas update/);
  }
});
