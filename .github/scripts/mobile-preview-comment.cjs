// The per-PR workflow lock covers the whole read/merge/write, including comment creation.
const MARKER = "mobile-preview-android";
const PROJECT_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const APP_SCHEME = "t3-code";

function readState(body) {
  const match = new RegExp(`^<!-- ${MARKER} (\\{.*\\}) -->`).exec(body ?? "");
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    const text = (value) => (typeof value === "string" ? value : "");
    return {
      fingerprint: text(state.fingerprint),
      client: text(state.client),
      group: text(state.group),
    };
  } catch {
    return null;
  }
}

/**
 * New values win; a new fingerprint drops the old fingerprint's client. A build that finishes
 * after the PR moved to another fingerprint changes nothing: its client cannot run the update
 * the comment now shows.
 */
function mergeState(previous, next) {
  const buildOnly = Boolean(next.client) && !next.group;
  if (
    buildOnly &&
    previous?.fingerprint &&
    next.fingerprint &&
    previous.fingerprint !== next.fingerprint
  ) {
    return previous;
  }
  const fingerprint = next.fingerprint || previous?.fingerprint || "";
  const sameFingerprint = !previous?.fingerprint || previous.fingerprint === fingerprint;
  return {
    fingerprint,
    client: next.client || (sameFingerprint ? (previous?.client ?? "") : ""),
    group: next.group || previous?.group || "",
  };
}

function render(state, runUrl) {
  const qr = `https://qr.expo.dev/eas-update?appScheme=${APP_SCHEME}&projectId=${PROJECT_ID}&groupId=${state.group}`;
  const rows = [
    `<!-- ${MARKER} ${JSON.stringify(state)} -->`,
    "🤖 Android preview",
    "",
    "&nbsp; | 🤖 Android",
    "--- | ---",
    `Fingerprint | ${state.fingerprint || "n/a"}`,
    `Dev client | ${state.client ? `[Install](${state.client})` : `Building on Blacksmith ([run](${runUrl})); this comment gets the install link when it finishes`}`,
  ];
  if (state.group) {
    rows.push(
      `Update Details | [Update Permalink](https://expo.dev/projects/${PROJECT_ID}/updates/${state.group})`,
      `Update QR | <a href="${qr}"><img src="${qr}" width="250px" height="250px" /></a>`,
    );
  }
  return rows.join("\n");
}

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

async function main({ env = process.env, request = github } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const pr = env.PR;
  if (!repository || !pr || !env.GH_TOKEN) {
    throw new Error("GITHUB_REPOSITORY, PR and GH_TOKEN are required.");
  }
  if (env.GROUP) {
    if (!env.HEAD_SHA) throw new Error("HEAD_SHA is required for update comments.");
    const pull = await request(`/repos/${repository}/pulls/${pr}`);
    if (pull.head.sha !== env.HEAD_SHA) {
      console.log("Skipping preview update for an outdated PR head.");
      return;
    }
  }
  const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;
  let existing = null;
  for (let page = 1; existing === null; page++) {
    const comments = await request(
      `/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`,
    );
    // Only this workflow's own comment: anyone can post the marker, and nobody else's is editable.
    existing =
      comments.find(
        (comment) =>
          comment.user?.login === "github-actions[bot]" && readState(comment.body) !== null,
      ) ?? null;
    if (comments.length < 100) break;
  }
  const state = mergeState(readState(existing?.body), {
    fingerprint: env.FINGERPRINT ?? "",
    client: env.CLIENT ?? "",
    group: env.GROUP ?? "",
  });
  const body = JSON.stringify({ body: render(state, runUrl) });
  if (existing) {
    await request(`/repos/${repository}/issues/comments/${existing.id}`, { method: "PATCH", body });
  } else {
    await request(`/repos/${repository}/issues/${pr}/comments`, { method: "POST", body });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main, mergeState, readState, render };
