// @effect-diagnostics nodeBuiltinImport:off -- integration test owns real temporary repositories and HTTP boundaries.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as CodespacesWorkspace from "./CodespacesWorkspace.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { resolveCodexWorkspaceAttachments } from "./CodexWorkspaceAttachments.ts";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkspaceSearchIndex from "../workspace/WorkspaceSearchIndex.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type {
  ChatAttachment,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
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
  it("marks ignored directory entries and keeps tracked or ordinary files unmarked", async () => {
    const test = await fixture();
    await NodeFSP.writeFile(
      NodePath.join(test.remote, ".gitignore"),
      "node_modules/\ngenerated.txt\nproof.txt\n",
    );
    await NodeFSP.mkdir(NodePath.join(test.remote, "node_modules"));
    await NodeFSP.writeFile(NodePath.join(test.remote, "node_modules", "module.js"), "module");
    await NodeFSP.writeFile(NodePath.join(test.remote, "generated.txt"), "generated");
    await NodeFSP.writeFile(NodePath.join(test.remote, "ordinary.txt"), "ordinary");
    const root = await test.call<{ entries: Array<{ path: string; ignored?: boolean }> }>(
      "entries",
      "list",
      [{ cwd: test.remote, directoryPath: "" }],
    );
    expect(root.body?.value.entries).toEqual(
      expect.arrayContaining([
        { path: "node_modules", kind: "directory", ignored: true },
        { path: "generated.txt", kind: "file", ignored: true },
        { path: "proof.txt", kind: "file" },
        { path: "ordinary.txt", kind: "file" },
      ]),
    );
    const nested = await test.call<{ entries: unknown[] }>("entries", "list", [
      { cwd: test.remote, directoryPath: "node_modules" },
    ]);
    expect(nested.body?.value.entries).toEqual([
      { path: "node_modules/module.js", kind: "file", ignored: true },
    ]);
  });
  it.effect("commits remote files without translating path-shaped subject or body text", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(fixture);
      yield* Effect.promise(async () => {
        await execute("git", ["config", "user.name", "Test"], { cwd: test.remote });
        await execute("git", ["config", "user.email", "test@example.com"], { cwd: test.remote });
        await NodeFSP.writeFile(NodePath.join(test.remote, "proof.txt"), "commit me\n");
      });
      const layer = CodespacesWorkspace.layer.pipe(
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeedNone,
            set: () => Effect.void,
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const workspace = yield* CodespacesWorkspace.CodespacesWorkspace;
        yield* workspace.bind({ projectId: "commit", localRoot: test.local, name: "space" });
        yield* workspace.register({
          name: "space",
          remoteRoot: test.remote,
          workerUrl: `http://127.0.0.1:${test.worker.port}`,
          execServerUrl: "ws://localhost:1",
          token: "executor-token",
        });
        const subject = test.local + "/documented-path";
        const body = test.local + "/more-details\nLeave these paths unchanged.";
        yield* workspace.call(test.local, "git", "commit", [
          test.local,
          subject,
          body,
          { stage: { filePaths: [test.local + "/proof.txt"] } },
        ]);
        const message = yield* Effect.promise(() =>
          execute("git", ["log", "-1", "--format=%B"], { cwd: test.remote }),
        );
        expect(message.stdout.trimEnd()).toBe(subject + "\n\n" + body);
        expect(yield* workspace.call(test.local, "git", "listWorktreePaths", [test.local])).toEqual(
          [test.local],
        );
        expect(
          (yield* Effect.promise(() =>
            execute("git", ["log", "-1", "--format=%s"], { cwd: test.local }),
          )).stdout.trim(),
        ).toBe("initial");
      }).pipe(Effect.provide(layer));
    }),
  );
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
  it("finds shortened paths, ranks exact filenames first, and retains search filters", async () => {
    const test = await fixture();
    for (const path of [
      "src/components/Composer.tsx",
      "src/components/composePrompt.ts",
      "docs/composer.tsx-notes.md",
      "images/Composer.png",
    ]) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(test.remote, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(test.remote, path), "fixture");
    }
    const search = async (query: string, extra = {}) =>
      (
        await test.call<ProjectSearchEntriesResult>("entries", "search", [
          { cwd: test.remote, query, limit: 10, ...extra },
        ])
      ).body!.value;
    const fuzzy = await search("  @./cmp  ");
    expect(fuzzy.entries).toContainEqual({ path: "src/components/Composer.tsx", kind: "file" });
    expect(fuzzy.entries).toContainEqual({ path: "src/components", kind: "directory" });
    expect((await search("Composer.tsx")).entries[0]?.path).toBe("src/components/Composer.tsx");
    const limited = await search("cmp", { kind: "file", limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.entries[0]?.kind).toBe("file");
    expect(limited.truncated).toBe(true);
    expect((await search("cmp", { imageOnly: true })).entries).toEqual([
      { path: "images/Composer.png", kind: "file" },
    ]);
    expect(
      (await search("cmp", { kind: "directory" })).entries.every(
        (entry) => entry.kind === "directory",
      ),
    ).toBe(true);
    expect((await search("does-not-match")).entries).toEqual([]);
  });
  it.effect(
    "routed saves stream large and JSON-expanded contents without changing local files",
    () =>
      Effect.gen(function* () {
        const test = yield* Effect.promise(fixture);
        const layer = CodespacesWorkspace.layer.pipe(
          Layer.provide(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedNone,
              set: () => Effect.void,
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const workspace = yield* CodespacesWorkspace.CodespacesWorkspace;
          yield* workspace.register({
            name: "space",
            remoteRoot: test.remote,
            workerUrl: `http://127.0.0.1:${test.worker.port}`,
            execServerUrl: "ws://localhost:1",
            token: "executor-token",
          });
          yield* workspace.bind({ projectId: "test", localRoot: test.local, name: "space" });
          yield* Effect.promise(() =>
            NodeFSP.chmod(NodePath.join(test.remote, "proof.txt"), 0o755),
          );
          const cases = [
            { relativePath: "proof.txt", contents: "large update\n".repeat(300000) },
            {
              relativePath: "nested/escaped & unicode.txt",
              contents: "\u0001".repeat(400000) + 'café 🙂 "\\\n',
            },
          ];
          for (const input of cases) {
            expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(2 * 1024 * 1024);
            const result = yield* workspace.call<ProjectWriteFileResult>(
              test.local,
              "files",
              "writeFile",
              [{ cwd: test.local, ...input }],
            );
            expect(result).toEqual({ relativePath: input.relativePath });
            expect(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(test.remote, input.relativePath), "utf8"),
              ),
            ).toBe(input.contents);
          }
          expect(
            (yield* Effect.promise(() => NodeFSP.stat(NodePath.join(test.remote, "proof.txt"))))
              .mode & 0o777,
          ).toBe(0o755);
          yield* Effect.promise(() =>
            NodeFSP.symlink("proof.txt", NodePath.join(test.remote, "linked.txt")),
          );
          yield* workspace.call(test.local, "files", "writeFile", [
            { cwd: test.local, relativePath: "linked.txt", contents: "updated through link" },
          ]);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(test.remote, "proof.txt"), "utf8"),
            ),
          ).toBe("updated through link");
          expect(
            (yield* Effect.promise(() =>
              NodeFSP.lstat(NodePath.join(test.remote, "linked.txt")),
            )).isSymbolicLink(),
          ).toBe(true);
          expect(
            yield* workspace
              .call<ProjectWriteFileResult>(test.local, "files", "writeFile", [
                { cwd: test.local, relativePath: "../outside.txt", contents: "escape" },
              ])
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "CodespacesError", code: "bootstrap" });
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(test.local, "proof.txt"), "utf8"),
            ),
          ).toBe("baseline\n");
          expect(
            (yield* Effect.promise(() => NodeFSP.readdir(test.remote))).some((name) =>
              name.startsWith(".t3-write-"),
            ),
          ).toBe(false);
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect(
    "stages large attachments outside Git and uses executor paths in provider prompts",
    () =>
      Effect.gen(function* () {
        const test = yield* Effect.promise(fixture);
        const attachmentsDir = NodePath.join(test.local, "attachments");
        yield* Effect.promise(() => NodeFSP.mkdir(attachmentsDir));
        const bytes = Buffer.alloc(3 * 1024 * 1024, 42);
        const attachment: ChatAttachment = {
          type: "file",
          id: "thread-11111111-1111-4111-8111-111111111111-pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: bytes.length,
        };
        const localPath = resolveAttachmentPath({ attachmentsDir, attachment })!;
        yield* Effect.promise(() => NodeFSP.writeFile(localPath, bytes));
        const layer = CodespacesWorkspace.layer.pipe(
          Layer.provide(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedNone,
              set: () => Effect.void,
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const workspace = yield* CodespacesWorkspace.CodespacesWorkspace;
          const input = { cwd: test.local, attachmentsDir, attachments: [attachment] };
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input)).get(attachment.id),
          ).toBe(localPath);
          yield* workspace.bind({ projectId: "attachments", localRoot: test.local, name: "space" });
          yield* workspace.register({
            name: "space",
            remoteRoot: test.remote,
            workerUrl: `http://127.0.0.1:${test.worker.port}`,
            execServerUrl: "ws://localhost:1",
            token: "executor-token",
          });
          const paths = yield* resolveCodexWorkspaceAttachments(workspace, input);
          const remotePath = paths.get(attachment.id)!;
          cleanups.push(() =>
            NodeFSP.rm(NodePath.dirname(remotePath), { recursive: true, force: true }),
          );
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input)).get(attachment.id),
          ).toBe(remotePath);
          const restarted = yield* Effect.promise(() => startWorker(test.remote, "restart-token"));
          cleanups.push(async () => {
            await new Promise<void>((resolve) => restarted.server.close(() => resolve()));
            await restarted.runtime.dispose();
          });
          yield* workspace.register({
            name: "space",
            remoteRoot: test.remote,
            workerUrl: `http://127.0.0.1:${restarted.port}`,
            execServerUrl: "ws://localhost:2",
            token: "restart-token",
          });
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input)).get(attachment.id),
          ).toBe(remotePath);
          const directory = NodePath.dirname(remotePath);
          expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([
            NodePath.basename(remotePath),
          ]);
          const pressure = NodePath.join(directory, "pressure.pdf");
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(pressure, "");
            await NodeFSP.truncate(pressure, 512 * 1024 * 1024);
          });
          yield* Effect.promise(() => NodeFSP.writeFile(localPath, Buffer.from("new contents")));
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input).pipe(Effect.flip)).code,
          ).toBe("storage");
          expect((yield* Effect.promise(() => NodeFSP.readFile(remotePath))).equals(bytes)).toBe(
            true,
          );
          expect((yield* Effect.promise(() => NodeFSP.readdir(directory))).sort()).toEqual(
            [NodePath.basename(remotePath), "pressure.pdf"].sort(),
          );
          yield* Effect.promise(() => NodeFSP.writeFile(localPath, bytes));
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input)).get(attachment.id),
          ).toBe(remotePath);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(remotePath, Buffer.alloc(bytes.length, 43)),
          );
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input).pipe(Effect.flip)).code,
          ).toBe("bootstrap");
          yield* Effect.promise(() => NodeFSP.writeFile(remotePath, bytes));
          expect(remotePath).not.toBe(localPath);
          expect(remotePath.startsWith(test.remote + "/")).toBe(false);
          expect((yield* Effect.promise(() => NodeFSP.readFile(remotePath))).equals(bytes)).toBe(
            true,
          );
          expect((yield* Effect.promise(() => NodeFSP.readFile(localPath))).equals(bytes)).toBe(
            true,
          );
          const prompt = providerMessageTextWithAttachmentPaths({
            text: "Read this report",
            attachments: [attachment],
            resolveAttachmentPath: (attachment) => paths.get(attachment.id) ?? null,
          });
          expect(prompt).toContain(remotePath);
          expect(prompt).not.toContain(localPath);
          yield* workspace.disconnect("space");
          expect(
            (yield* resolveCodexWorkspaceAttachments(workspace, input).pipe(Effect.flip)).code,
          ).toBe("conflict");
        }).pipe(Effect.provide(layer));
        expect(
          (yield* Effect.promise(() =>
            execute("git", ["status", "--porcelain"], { cwd: test.remote }),
          )).stdout,
        ).toBe("");
        yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const bad = yield* client.execute(
            HttpClientRequest.post(
              `http://127.0.0.1:${test.worker.port}/attachments/..%2Fescape`,
            ).pipe(
              HttpClientRequest.setHeader("authorization", "Bearer executor-token"),
              HttpClientRequest.bodyText("escape"),
            ),
          );
          expect(bad.status).toBe(400);
          const unauthorized = yield* client.execute(
            HttpClientRequest.post(
              `http://127.0.0.1:${test.worker.port}/attachments/report.pdf`,
            ).pipe(HttpClientRequest.bodyText("private bytes")),
          );
          expect(unauthorized.status).toBe(401);
        }).pipe(Effect.provide(FetchHttpClient.layer));
      }),
  );
  it.effect(
    "uses the local content engine for regex escapes, Unicode and punctuation word edges",
    () =>
      Effect.gen(function* () {
        const test = yield* Effect.promise(fixture);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(test.remote, "rules.txt"),
            "123 abc ١٢٣\na-foo-b -foo-\nSquare square\n[ invalid [\n😀 café CAFÉ caféine\n",
          ),
        );
        yield* Effect.gen(function* () {
          const index = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          for (const options of [
            { query: "\\d+", useRegex: true, wholeWord: false, caseSensitive: true },
            { query: "-foo-", useRegex: false, wholeWord: true, caseSensitive: true },
            { query: "\\SQUARE", useRegex: true, wholeWord: false, caseSensitive: false },
            { query: "[", useRegex: true, wholeWord: false, caseSensitive: false },
            { query: "café", useRegex: false, wholeWord: true, caseSensitive: false },
          ]) {
            const input = { cwd: test.remote, limit: 50, ...options };
            const expected = yield* index.searchContents(input);
            const actual = yield* Effect.promise(() =>
              test.call<ProjectSearchContentsResult>("entries", "searchContents", [input]),
            );
            expect(actual.response.status).toBe(200);
            expect(actual.body!.value).toEqual(expected);
            if (options.query === "\\d+")
              expect(expected.matches[0]?.matchRanges).toEqual([{ start: 0, end: 3 }]);
            if (options.query === "-foo-") expect(expected.matches[0]?.matchRanges).toHaveLength(2);
            if (options.query === "[") expect(expected.matches[0]?.matchRanges).toHaveLength(2);
          }
        }).pipe(
          Effect.provide(
            WorkspaceSearchIndex.layer(
              WorkspaceSearchIndex.workspaceSearchIndexKey(test.remote, "content"),
            ),
          ),
        );
      }),
  );
  it("highlights repeated Unicode matches and reports invalid regex fallback", async () => {
    const test = await fixture();
    await NodeFSP.writeFile(
      NodePath.join(test.remote, "search:2:file.txt"),
      "😀 café café caféine\n[ invalid [\n",
    );
    const search = async (query: string, useRegex = false, wholeWord = false) => {
      const result = await test.call<ProjectSearchContentsResult>("entries", "searchContents", [
        {
          cwd: test.remote,
          query,
          useRegex,
          wholeWord,
          caseSensitive: false,
          limit: 10,
        },
      ]);
      expect(result.response.status).toBe(200);
      return result.body!.value;
    };
    const literal = await search("café");
    expect(literal.matches).toEqual([
      {
        path: "search:2:file.txt",
        lineNumber: 1,
        lineContent: "😀 café café caféine",
        matchRanges: [
          { start: 3, end: 7 },
          { start: 8, end: 12 },
          { start: 13, end: 17 },
        ],
      },
    ]);
    expect((await search("café", false, true)).matches[0]?.matchRanges).toEqual([
      { start: 3, end: 7 },
      { start: 8, end: 12 },
    ]);
    expect((await search("caf.", true)).matches[0]?.matchRanges).toEqual(
      literal.matches[0]?.matchRanges,
    );
    const invalid = await search("[", true);
    expect(invalid.regexFallbackError).toBeTruthy();
    expect(invalid.matches[0]).toMatchObject({
      lineNumber: 2,
      matchRanges: [
        { start: 0, end: 1 },
        { start: 10, end: 11 },
      ],
    });
    expect(await search("no-such-text")).toEqual({ matches: [], truncated: false });
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
