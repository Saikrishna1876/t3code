const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { main, mergeState, readState, render } = require("./mobile-preview-comment.cjs");

const fingerprint = "c31608b37a8a2dca35ccee39cfd2ec7305042629";
const run = "https://github.com/pingdotgg/t3code/actions/runs/1";

test("the comment round-trips its state", () => {
  const state = { fingerprint, client: "", group: "8e413a0a" };
  const body = render(state, run);
  assert.deepEqual(readState(body), state);
  assert.match(
    body,
    /Building on Blacksmith \(\[run\]\(https:\/\/github\.com\/pingdotgg\/t3code\/actions\/runs\/1\)\)/,
  );
  assert.match(
    body,
    /qr\.expo\.dev\/eas-update\?appScheme=t3-code&projectId=[0-9a-f-]+&groupId=8e413a0a/,
  );
  assert.equal(readState("🚀 Expo continuous deployment is ready!"), null);
});

test("the build job adds the install link without losing the update", () => {
  const first = mergeState(null, { fingerprint, client: "", group: "8e413a0a" });
  const built = mergeState(first, { fingerprint, client: "https://expo.dev/a/b", group: "" });
  assert.deepEqual(built, { fingerprint, client: "https://expo.dev/a/b", group: "8e413a0a" });
  assert.match(render(built, run), /Dev client \| \[Install\]\(https:\/\/expo\.dev\/a\/b\)/);
});

test("a new fingerprint drops the old client; the same one keeps it", () => {
  const built = { fingerprint, client: "https://expo.dev/a/b", group: "old" };
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
    {
      fingerprint: "",
      client: "",
      group: "",
    },
  );
});

test("all Android comment writers share a lock outside the build jobs", () => {
  for (const name of ["mobile-eas-preview", "mobile-eas-preview-fork"]) {
    const workflow = readFileSync(join(__dirname, `../workflows/${name}.yml`), "utf8");
    assert.doesNotMatch(workflow, /run: node .*mobile-preview-comment\.cjs/);
    assert.equal(
      (workflow.match(/uses: \.\/\.github\/workflows\/mobile-preview-comment\.yml/g) ?? []).length,
      2,
    );
    assert.match(
      workflow,
      /if: \$\{\{ !cancelled\(\) && needs\.android-build\.outputs\.client != '' \}\}/,
    );
    assert.match(
      workflow,
      /needs\.android-comment\.result != 'success' && needs\.(android|preview)\.outputs\.group/,
    );
    assert.doesNotMatch(workflow, /GH_TOKEN:.*\n(?:      [^\n]*\n)*    steps:/);
  }
  const writer = readFileSync(join(__dirname, "../workflows/mobile-preview-comment.yml"), "utf8");
  assert.match(writer, /group: mobile-preview-android-comment-\$\{\{ inputs\.pr \}\}/);
  assert.match(writer, /cancel-in-progress: false/);
  assert.match(writer, /queue: max/);
  assert.match(writer, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(writer, /pnpm|eas build|eas update/);
});

test("only current-head updates run, while older builds can still add their client", async () => {
  for (const [head, group, expectedWrites] of [
    ["older-head", "older-update", 0],
    ["current-head", "new-update", 1],
    ["older-head", "", 1],
  ]) {
    const current = { fingerprint, client: "", group: "current" };
    const writes = [];
    await main({
      env: {
        GITHUB_REPOSITORY: "acme/app",
        PR: "1",
        GH_TOKEN: "fixture",
        HEAD_SHA: head,
        FINGERPRINT: fingerprint,
        GROUP: group,
        CLIENT: "https://expo.dev/a/b",
      },
      request: async (path, init = {}) => {
        if (init.method) {
          writes.push(JSON.parse(init.body));
          return {};
        }
        if (path.endsWith("/pulls/1")) return { head: { sha: "current-head" } };
        return [{ id: 1, user: { login: "github-actions[bot]" }, body: render(current, run) }];
      },
    });
    assert.equal(writes.length, expectedWrites);
  }
});
