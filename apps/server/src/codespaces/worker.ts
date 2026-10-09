// @effect-diagnostics nodeBuiltinImport:off -- standalone execution worker owns Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
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
  type ProjectEntry,
  type ProjectListEntriesInput,
  type ProjectSearchEntriesInput,
  type ProjectSearchContentsInput,
  type FilesystemBrowseInput,
} from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const encodeVcsError = Schema.encodeSync(Schema.toCodecJson(VcsError));
const MAX_FILE_BYTES = 1024 * 1024;

/** Only workspace execution lives here. No provider, login, project store or conversation database. */
export async function startWorker(root: string, token: string, port = 0) {
  const workspaceRoot = await NodeFSP.realpath(root);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(GitVcsDriver.GitVcsDriver, GitVcsDriver.make),
      Layer.effect(SchemaDriver, GitVcsDriver.makeVcsDriver),
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
    const target = NodePath.resolve(workspaceRoot, value);
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
  const filesystem = {
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
      return {
        entries: children
          .filter((child) => child.name !== ".git" && (child.isDirectory() || child.isFile()))
          .slice(0, 10000)
          .map((child) => ({
            path: NodePath.posix.join(input.directoryPath!, child.name),
            kind: child.isDirectory() ? "directory" : "file",
          })),
        truncated: children.length > 10000,
      };
    },
    search: async (input: ProjectSearchEntriesInput) => {
      const listed = await recursiveEntries(input.cwd);
      const query = input.query.replace(/^[@./]+/, "").toLowerCase();
      const filtered = listed.entries.filter(
        (entry) =>
          (!input.kind || entry.kind === input.kind) &&
          entry.path.toLowerCase().includes(query) &&
          (!input.imageOnly || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(entry.path)),
      );
      return {
        entries: filtered.slice(0, input.limit),
        truncated: listed.truncated || filtered.length > input.limit,
      };
    },
    searchContents: async (input: ProjectSearchContentsInput) => {
      // Include untracked workspace edits while honoring Git ignore rules and output limits.
      const result = await runtime.runPromise(
        driver.execute({
          operation: "workspace.searchContents",
          cwd: input.cwd,
          args: [
            "-c",
            "core.quotePath=false",
            "grep",
            "--untracked",
            "--exclude-standard",
            "-n",
            "-I",
            ...(input.caseSensitive ? [] : ["-i"]),
            ...(input.wholeWord ? ["-w"] : []),
            input.useRegex ? "-E" : "-F",
            "-e",
            input.query,
            "--",
            ".",
          ],
          allowNonZeroExit: true,
          maxOutputBytes: MAX_FILE_BYTES,
        }),
      );
      const matches = result.stdout.split("\n").flatMap((line) => {
        const parsed = /^(.+?):(\d+):(.*)$/.exec(line);
        return parsed
          ? [
              {
                path: parsed[1]!,
                lineNumber: Number(parsed[2]),
                lineContent: parsed[3]!,
                matchRanges: [],
              },
            ]
          : [];
      });
      return {
        matches: matches.slice(0, input.limit),
        truncated: result.stdoutTruncated || matches.length > input.limit,
      };
    },
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
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error("Workspace request is too large.");
        chunks.push(Buffer.from(chunk));
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!isCall(payload)) throw new Error("Invalid workspace request.");
      const group = groups[payload.group as keyof typeof groups];
      if (!group || !Object.hasOwn(group, payload.method))
        throw new Error("Unknown workspace operation.");
      // Local controller supplies this RPC. Validate every cwd before any Git operation.
      for (const argument of payload.args) {
        if (typeof argument === "string" && NodePath.isAbsolute(argument))
          await validPath(argument);
        if (
          argument &&
          typeof argument === "object" &&
          "cwd" in argument &&
          typeof argument.cwd === "string"
        )
          await validPath(argument.cwd);
      }
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
    } catch {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ message: "Codespace workspace operation failed." }));
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
