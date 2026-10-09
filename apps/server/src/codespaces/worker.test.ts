// @effect-diagnostics nodeBuiltinImport:off -- integration test owns real temporary repositories and HTTP boundaries.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { startWorker } from "./worker.ts";
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-proof-")),
  );
  cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const local = NodePath.join(root, "local");
  const remote = NodePath.join(root, "remote");
  await NodeFSP.mkdir(local);
  await NodeFSP.mkdir(remote);
  for (const cwd of [local, remote]) {
    await execute("git", ["init", "-q"], { cwd });
    await NodeFSP.writeFile(NodePath.join(cwd, "proof.txt"), "baseline\n");
    await execute("git", ["add", "."], { cwd });
    await execute(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "initial"],
      { cwd },
    );
  }
  const worker = await startWorker(remote, "executor-token");
  cleanups.push(async () => {
    await new Promise<void>((resolve) => worker.server.close(() => resolve()));
    await worker.runtime.dispose();
  });
  async function call<A = unknown>(
    group: string,
    method: string,
    args: unknown[],
    token = "executor-token",
  ) {
    // @effect-diagnostics-next-line globalFetch:off -- exercises the real standalone HTTP boundary.
    const response = await fetch(`http://127.0.0.1:${worker.port}/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ group, method, args }),
    });
    return {
      response,
      body: response.status === 200 ? ((await response.json()) as { value: A }) : null,
    };
  }
  return { local, remote, call, worker };
}
describe("Codespace workspace worker", () => {
  it("edits and checkpoints remote files while preserving local checkout and remote staging", async () => {
    const test = await fixture();
    const baseline = "refs/t3/orchestration-v2/checkpoints/test/baseline";
    const after = "refs/t3/orchestration-v2/checkpoints/test/after";
    expect(
      (
        await test.call("checkpoints", "captureCheckpoint", [
          { cwd: test.remote, checkpointRef: baseline },
        ])
      ).body,
    ).toEqual({ value: null });
    await test.call("files", "writeFile", [
      { cwd: test.remote, relativePath: "proof.txt", contents: "remote work\n" },
    ]);
    expect(
      (
        await test.call("checkpoints", "captureCheckpoint", [
          { cwd: test.remote, checkpointRef: after },
        ])
      ).body,
    ).toEqual({ value: null });
    const diff = await test.call("checkpoints", "diffCheckpoints", [
      {
        cwd: test.remote,
        fromCheckpointRef: baseline,
        toCheckpointRef: after,
        ignoreWhitespace: false,
      },
    ]);
    expect(diff.body?.value).toContain("+remote work");
    expect(await NodeFSP.readFile(NodePath.join(test.local, "proof.txt"), "utf8")).toBe(
      "baseline\n",
    );
    expect((await execute("git", ["diff", "--cached"], { cwd: test.remote })).stdout).toBe("");
    await test.call("checkpoints", "restoreCheckpoint", [
      { cwd: test.remote, checkpointRef: baseline },
    ]);
    expect(await NodeFSP.readFile(NodePath.join(test.remote, "proof.txt"), "utf8")).toBe(
      "baseline\n",
    );
  });
  it("lists and reads remote workspace files", async () => {
    const test = await fixture();
    await NodeFSP.writeFile(NodePath.join(test.remote, "only-remote.txt"), "hello remote");
    expect(
      (
        await test.call<{ entries: unknown[] }>("entries", "list", [
          { cwd: test.remote, directoryPath: "" },
        ])
      ).body?.value.entries,
    ).toContainEqual({ path: "only-remote.txt", kind: "file" });
    expect(
      (
        await test.call<{ contents: string }>("files", "readFile", [
          { cwd: test.remote, relativePath: "only-remote.txt" },
        ])
      ).body?.value.contents,
    ).toBe("hello remote");
  });
  it("rejects missing executor authorization, traversal and symlink escapes", async () => {
    const test = await fixture();
    expect(
      (
        await test.call(
          "files",
          "readFile",
          [{ cwd: test.remote, relativePath: "proof.txt" }],
          "wrong-token",
        )
      ).response.status,
    ).toBe(401);
    expect(
      (
        await test.call("files", "writeFile", [
          { cwd: test.remote, relativePath: "../local/proof.txt", contents: "wrong" },
        ])
      ).response.status,
    ).toBe(400);
    await NodeFSP.symlink(test.local, NodePath.join(test.remote, "escape"));
    expect(
      (
        await test.call("files", "writeFile", [
          { cwd: test.remote, relativePath: "escape/proof.txt", contents: "wrong" },
        ])
      ).response.status,
    ).toBe(400);
    expect(await NodeFSP.readFile(NodePath.join(test.local, "proof.txt"), "utf8")).toBe(
      "baseline\n",
    );
  });
});
