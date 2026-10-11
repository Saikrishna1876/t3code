// @effect-diagnostics nodeBuiltinImport:off -- standalone execution worker owns Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import {
  VcsError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ProjectEntry,
  type ProjectListEntriesInput,
  type ProjectSearchEntriesInput,
  type ProjectSearchContentsInput,
  type FilesystemBrowseInput,
} from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspaceSearchIndex from "../workspace/WorkspaceSearchIndex.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import {
  normalizeSearchQuery,
  scoreQueryMatch,
  insertRankedSearchResult,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const encodeVcsError = Schema.encodeSync(Schema.toCodecJson(VcsError));
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_ATTACHMENT_CACHE_FILES = 1024;
class AttachmentCacheFullError extends Error {}

/** Only workspace execution lives here. No provider, login, project store or conversation database. */
export async function startWorker(root: string, token: string, port = 0) {
  const workspaceRoot = await NodeFSP.realpath(root);
  const workspaceAlias = NodePath.resolve(root);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(GitVcsDriver.GitVcsDriver, GitVcsDriver.make),
      Layer.effect(SchemaDriver, GitVcsDriver.makeVcsDriver),
      WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer,
    ).pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "t3-codespaces-worker-" })),
      Layer.provide(NodeServices.layer),
    ),
  );
  const git = await runtime.runPromise(GitVcsDriver.GitVcsDriver);
  const driver = await runtime.runPromise(SchemaDriver);
  const checkpoints = driver.checkpoints!;
  const validPath = async (value: string, writing = false) => {
    let target = NodePath.resolve(workspaceRoot, value);
    if (target === workspaceAlias || target.startsWith(workspaceAlias + NodePath.sep))
      target = NodePath.resolve(workspaceRoot, NodePath.relative(workspaceAlias, target));
    const inside = (p: string) => p === workspaceRoot || p.startsWith(workspaceRoot + NodePath.sep);
    if (!inside(target)) throw new Error("Path is outside the Codespace workspace.");
    let existing = target;
    while (writing) {
      try {
        await NodeFSP.lstat(existing);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const parent = NodePath.dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    if (!inside(await NodeFSP.realpath(existing)))
      throw new Error("Symlink leaves the Codespace workspace.");
    return target;
  };
  const openAsset = async (cwd: string, relativePath: string) => {
    const candidate = await validPath(NodePath.resolve(cwd, relativePath));
    const target = await NodeFSP.realpath(candidate);
    if (target !== workspaceRoot && !target.startsWith(workspaceRoot + NodePath.sep))
      throw new Error("Asset leaves the Codespace workspace.");
    const before = await NodeFSP.lstat(target);
    if (!before.isFile()) throw new Error("Asset is not a regular file.");
    const handle = await NodeFSP.open(
      target,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino)
        throw new Error("Asset changed while opening.");
      if ((await NodeFSP.realpath(target)) !== target)
        throw new Error("Asset path changed while opening.");
      const after = await NodeFSP.lstat(target);
      if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino)
        throw new Error("Asset changed while opening.");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  // Stable content paths survive reconnects and remain readable from conversation history.
  // The cap preserves existing references instead of evicting files an active turn may still use.
  const attachmentDirectory = NodePath.join(
    await NodeFSP.realpath(NodeOS.tmpdir()),
    "t3-codespace-attachments-" +
      NodeCrypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32),
  );
  let pendingUpload = Promise.resolve();
  const stageAttachment = async (name: string, request: NodeHttp.IncomingMessage) => {
    const previous = pendingUpload;
    let release!: () => void;
    pendingUpload = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let partial: string | undefined;
    try {
      await NodeFSP.mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
      if ((await NodeFSP.realpath(attachmentDirectory)) !== attachmentDirectory)
        throw new Error("Attachment cache path changed.");
      partial = NodePath.join(attachmentDirectory, ".upload-" + NodeCrypto.randomUUID());
      const handle = await NodeFSP.open(partial, "wx", 0o600);
      const digest = NodeCrypto.createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) throw new Error("Attachment is too large.");
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
      } finally {
        await handle.close();
      }
      const contentHash = digest.digest("hex");
      const target = NodePath.join(attachmentDirectory, contentHash + NodePath.extname(name));
      const entries = await NodeFSP.readdir(attachmentDirectory, { withFileTypes: true });
      let bytes = 0;
      let files = 0;
      for (const entry of entries) {
        const path = NodePath.join(attachmentDirectory, entry.name);
        if (path === partial) continue;
        const info = await NodeFSP.lstat(path);
        if (!info.isFile()) throw new Error("Attachment cache contains an invalid entry.");
        if (path === target) {
          if (info.size !== size) throw new Error("Cached attachment changed.");
          const cached = await NodeFSP.open(
            target,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
          );
          try {
            const identity = await cached.stat();
            if (identity.dev !== info.dev || identity.ino !== info.ino)
              throw new Error("Cached attachment changed.");
            const existingHash = NodeCrypto.createHash("sha256");
            for await (const chunk of cached.createReadStream({ autoClose: false }))
              existingHash.update(chunk);
            if (existingHash.digest("hex") !== contentHash)
              throw new Error("Cached attachment changed.");
          } finally {
            await cached.close();
          }
          return target;
        }
        bytes += info.size;
        files++;
      }
      if (bytes + size > MAX_ATTACHMENT_CACHE_BYTES || files >= MAX_ATTACHMENT_CACHE_FILES)
        throw new AttachmentCacheFullError();
      await NodeFSP.rename(partial, target);
      return target;
    } finally {
      try {
        if (partial) await NodeFSP.rm(partial, { force: true });
      } finally {
        release();
      }
    }
  };
  const filesystem = {
    inspectAsset: async (input: { cwd: string; relativePath: string }) => {
      const handle = await openAsset(input.cwd, input.relativePath);
      try {
        const stat = await handle.stat();
        const bytes = Buffer.alloc(Math.min(8192, stat.size));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        return {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          headerBase64: bytes.subarray(0, bytesRead).toString("base64"),
        };
      } finally {
        await handle.close();
      }
    },
    readFile: async (input: { cwd: string; relativePath: string }) => {
      const target = await validPath(NodePath.resolve(input.cwd, input.relativePath));
      const handle = await NodeFSP.open(target, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Path is not a regular file.");
        const bytes = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytes.subarray(0, bytesRead).includes(0))
          throw new Error("Binary files cannot be shown as text.");
        return {
          relativePath: input.relativePath,
          contents: bytes.subarray(0, bytesRead).toString("utf8"),
          byteLength: stat.size,
          truncated: stat.size > MAX_FILE_BYTES,
        };
      } finally {
        await handle.close();
      }
    },
    writeFile: async (input: { cwd: string; relativePath: string; contents: string }) => {
      const target = await validPath(NodePath.resolve(input.cwd, input.relativePath), true);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, input.contents);
      return { relativePath: input.relativePath };
    },
  };
  const writeFileStream = async (
    cwd: string,
    relativePath: string,
    request: NodeHttp.IncomingMessage,
  ) => {
    const candidate = await validPath(NodePath.resolve(cwd, relativePath), true);
    await NodeFSP.mkdir(NodePath.dirname(candidate), { recursive: true });
    let target = candidate;
    let mode: number | undefined;
    try {
      target = await NodeFSP.realpath(candidate);
      const info = await NodeFSP.stat(target);
      if (!info.isFile()) throw new Error("Path is not a regular file.");
      mode = info.mode & 0o777;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporary = NodePath.join(
      NodePath.dirname(target),
      ".t3-write-" + NodeCrypto.randomUUID(),
    );
    try {
      await NodeStreamPromises.pipeline(
        request,
        NodeFS.createWriteStream(temporary, { flags: "wx", mode }),
      );
      if (mode !== undefined) await NodeFSP.chmod(temporary, mode);
      await validPath(target, true);
      await NodeFSP.rename(temporary, target);
      return { relativePath };
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  };
  const recursiveEntries = async (cwd: string) => {
    const files = await runtime.runPromise(driver.listWorkspaceFiles(cwd));
    const items = new Map<string, ProjectEntry>();
    for (const file of files.paths) {
      items.set(file, { path: file, kind: "file" });
      let directory = NodePath.posix.dirname(file);
      while (directory !== ".") {
        items.set(directory, { path: directory, kind: "directory" });
        directory = NodePath.posix.dirname(directory);
      }
    }
    return {
      entries: [...items.values()].slice(0, 20000),
      truncated: files.truncated || items.size > 20000,
    };
  };
  const entries = {
    list: async (input: ProjectListEntriesInput) => {
      if (input.directoryPath === undefined) return recursiveEntries(input.cwd);
      const directory = await validPath(NodePath.resolve(input.cwd, input.directoryPath));
      if (NodePath.relative(workspaceRoot, directory).split(NodePath.sep).includes(".git"))
        throw new Error("Cannot browse Git metadata.");
      const children = await NodeFSP.readdir(directory, { withFileTypes: true });
      const listed: ProjectEntry[] = children
        .filter((child) => child.name !== ".git" && (child.isDirectory() || child.isFile()))
        .slice(0, 10000)
        .map((child) => ({
          path: NodePath.posix.join(input.directoryPath!, child.name),
          kind: child.isDirectory() ? "directory" : "file",
        }));
      const ignored = new Set<string>();
      for (let offset = 0; offset < listed.length; offset += 1000) {
        const result = await runtime.runPromise(
          git
            .execute({
              operation: "WorkspaceEntries.list",
              cwd: input.cwd,
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              stdin:
                listed
                  .slice(offset, offset + 1000)
                  .map((entry) => entry.path)
                  .join("\0") + "\0",
              allowNonZeroExit: true,
              timeoutMs: 10000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined)),
        );
        if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
        for (const path of result.stdout.split("\0")) ignored.add(path);
      }
      return {
        entries: listed.map((entry) =>
          ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
        ),
        truncated: children.length > 10000,
      };
    },
    search: async (input: ProjectSearchEntriesInput) => {
      const listed = await recursiveEntries(input.cwd);
      const query = normalizeSearchQuery(input.query, { trimLeadingPattern: /^[@./]+/ });
      const ranked: RankedSearchResult<ProjectEntry>[] = [];
      let matched = 0;
      for (const entry of listed.entries) {
        if (input.kind && entry.kind !== input.kind) continue;
        if (input.imageOnly && !isWorkspaceImagePreviewPath(entry.path)) continue;
        const path = entry.path.toLowerCase();
        const nameScore = scoreQueryMatch({
          value: NodePath.posix.basename(path),
          query,
          exactBase: 0,
          prefixBase: 100,
          boundaryBase: 200,
          includesBase: 300,
          fuzzyBase: 1000,
        });
        const pathScore = scoreQueryMatch({
          value: path,
          query,
          exactBase: 10,
          prefixBase: 400,
          boundaryBase: 500,
          includesBase: 600,
          fuzzyBase: 2000,
        });
        const score = query ? Math.min(nameScore ?? Infinity, pathScore ?? Infinity) : 0;
        if (!Number.isFinite(score)) continue;
        matched++;
        insertRankedSearchResult(ranked, { item: entry, score, tieBreaker: path }, input.limit);
      }
      return {
        entries: ranked.map(({ item }) => item),
        truncated: listed.truncated || matched > input.limit,
      };
    },
    searchContents: async (input: ProjectSearchContentsInput) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const cwd = yield* Effect.promise(() => validPath(input.cwd));
          const indexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
          return yield* Effect.gen(function* () {
            const index = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
            return yield* index.searchContents(input);
          }).pipe(
            Effect.provide(
              indexes.get(WorkspaceSearchIndex.workspaceSearchIndexKey(cwd, "content")),
            ),
          );
        }),
      ),
    browse: async (input: FilesystemBrowseInput) => {
      const resolved = NodePath.resolve(input.cwd ?? workspaceRoot, input.partialPath);
      const trailing = /[\\/]$/.test(input.partialPath);
      const parentPath = trailing ? resolved : NodePath.dirname(resolved);
      const prefix = trailing ? "" : NodePath.basename(resolved).toLowerCase();
      await validPath(parentPath);
      const children = await NodeFSP.readdir(parentPath, { withFileTypes: true });
      return {
        parentPath,
        entries: children
          .filter((child) => child.isDirectory() && child.name.toLowerCase().startsWith(prefix))
          .map((child) => ({ name: child.name, fullPath: NodePath.join(parentPath, child.name) })),
      };
    },
    refresh: async () => null,
  };
  const groups = { git, vcs: driver, checkpoints, files: filesystem, entries };
  const server = NodeHttp.createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !NodeCrypto.timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ workspaceRoot }));
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/files/write") {
        const cwd = url.searchParams.get("cwd");
        const relativePath = url.searchParams.get("relativePath");
        if (!cwd || !relativePath) throw new Error("Invalid file write request.");
        await validPath(cwd);
        const value = await writeFileStream(cwd, relativePath, request);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ value }));
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/attachments/")) {
        const name = decodeURIComponent(request.url.slice("/attachments/".length));
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(name))
          throw new Error("Invalid attachment name.");
        const target = await stageAttachment(name, request);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ path: target }));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error("Workspace request is too large.");
        chunks.push(Buffer.from(chunk));
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (request.method === "POST" && request.url === "/asset") {
        if (
          !payload ||
          typeof payload !== "object" ||
          !("cwd" in payload) ||
          typeof payload.cwd !== "string" ||
          !("relativePath" in payload) ||
          typeof payload.relativePath !== "string" ||
          !("offset" in payload) ||
          typeof payload.offset !== "number" ||
          !("size" in payload) ||
          typeof payload.size !== "number" ||
          !Number.isSafeInteger(payload.offset) ||
          payload.offset < 0 ||
          !Number.isSafeInteger(payload.size) ||
          payload.size < 0
        )
          throw new Error("Invalid asset request.");
        const handle = await openAsset(payload.cwd, payload.relativePath);
        try {
          const stat = await handle.stat();
          if (payload.offset + payload.size > stat.size)
            throw new Error("Asset changed during request.");
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": payload.size,
          });
          if (payload.size === 0) response.end();
          else
            await NodeStreamPromises.pipeline(
              handle.createReadStream({
                autoClose: false,
                start: payload.offset,
                end: payload.offset + payload.size - 1,
              }),
              response,
            );
        } finally {
          await handle.close();
        }
        return;
      }
      if (!isCall(payload)) throw new Error("Invalid workspace request.");
      const group = groups[payload.group as keyof typeof groups];
      if (!group || !Object.hasOwn(group, payload.method))
        throw new Error("Unknown workspace operation.");
      // Every port takes cwd first, either directly or in its input. Later strings are opaque.
      const input = payload.args[0];
      if (typeof input === "string") await validPath(input);
      else if (
        input &&
        typeof input === "object" &&
        "cwd" in input &&
        typeof input.cwd === "string"
      )
        await validPath(input.cwd);
      else throw new Error("Workspace operation requires cwd.");
      // The allowlisted service ports are constructed above with no remaining Effect requirements.
      const method = Reflect.get(group, payload.method) as (
        ...args: unknown[]
      ) => Effect.Effect<unknown, VcsError> | Promise<unknown>;
      const result = method(...payload.args);
      const body = Effect.isEffect(result)
        ? await runtime.runPromise(
            result.pipe(
              Effect.match({
                onSuccess: (value) => ({ value: value ?? null }),
                onFailure: (error) => ({
                  error: encodeVcsError(error),
                }),
              }),
            ),
          )
        : { value: (await result) ?? null };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response
        .writeHead(error instanceof AttachmentCacheFullError ? 507 : 400, {
          "content-type": "application/json",
        })
        .end(
          JSON.stringify({
            message:
              error instanceof AttachmentCacheFullError
                ? "Codespace attachment storage is full."
                : "Codespace workspace operation failed.",
          }),
        );
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, runtime, port: (server.address() as { port: number }).port };
}

import * as Context from "effect/Context";
class SchemaDriver extends Context.Service<
  SchemaDriver,
  import("../vcs/VcsDriver.ts").VcsDriver["Service"]
>()("t3/codespaces/worker/SchemaDriver") {}
function isCall(value: unknown): value is { group: string; method: string; args: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "group" in value &&
    typeof value.group === "string" &&
    "method" in value &&
    typeof value.method === "string" &&
    "args" in value &&
    Array.isArray(value.args)
  );
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [root, tokenFile, port] = process.argv.slice(2);
  if (!root || !tokenFile) throw new Error("Workspace root and token file are required.");
  const worker = await startWorker(
    root,
    (await NodeFSP.readFile(tokenFile, "utf8")).trim(),
    Number(port ?? 0),
  );
  process.stdout.write(JSON.stringify({ port: worker.port }) + "\n");
  const stop = () =>
    worker.server.close(() => {
      void worker.runtime.dispose().then(() => process.exit(0));
    });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
