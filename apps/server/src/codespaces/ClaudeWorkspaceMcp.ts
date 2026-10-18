// @effect-diagnostics nodeBuiltinImport:off -- adapts the standalone workspace worker to MCP and Node processes.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import type * as NodeHttp from "node:http";
import type { ProjectSearchContentsInput, ProjectSearchContentsResult } from "@t3tools/contracts";

const optionalString = Schema.optionalKey(Schema.String);
const optionalNumber = Schema.optionalKey(
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const schemas = {
  Read: Schema.Struct({ file_path: Schema.String, offset: optionalNumber, limit: optionalNumber }),
  Glob: Schema.Struct({ pattern: Schema.String, path: optionalString }),
  Grep: Schema.Struct({
    pattern: Schema.String,
    path: optionalString,
    "-i": Schema.optionalKey(Schema.Boolean),
  }),
  Write: Schema.Struct({ file_path: Schema.String, content: Schema.String }),
  Edit: Schema.Struct({
    file_path: Schema.String,
    old_string: Schema.String,
    new_string: Schema.String,
    replace_all: Schema.optionalKey(Schema.Boolean),
  }),
  Bash: Schema.Struct({
    command: Schema.String,
    timeout: optionalNumber,
    run_in_background: Schema.optionalKey(Schema.Boolean),
  }),
};
const descriptions = {
  Read: "Read a UTF-8 file in the Codespace. Optional 1-based line offset and line limit.",
  Glob: "List up to 1000 matching Codespace paths using a glob pattern under path or the workspace root. Results are relative to the workspace root.",
  Grep: "Search Codespace file contents with a regular expression. Returns matching lines and workspace-relative paths.",
  Write: "Write a UTF-8 file in the Codespace, creating parent directories when needed.",
  Edit: "Replace an exact string in a Codespace file. Requires a unique match unless replace_all is true.",
  Bash: "Run a foreground shell command in the Codespace workspace root. Timeout is capped at 120 seconds. Output is bounded. Persistent servers belong in the project terminal.",
};
const readTools = new Set(["Read", "Glob", "Grep"]);
const decodeRead = Schema.decodeUnknownSync(schemas.Read);
const decodeGlob = Schema.decodeUnknownSync(schemas.Glob);
const decodeGrep = Schema.decodeUnknownSync(schemas.Grep);
const decodeWrite = Schema.decodeUnknownSync(schemas.Write);
const decodeEdit = Schema.decodeUnknownSync(schemas.Edit);
const decodeBash = Schema.decodeUnknownSync(schemas.Bash);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

export async function handleClaudeWorkspaceMcp(input: {
  request: NodeHttp.IncomingMessage;
  response: NodeHttp.ServerResponse;
  payload: unknown;
  root: string;
  readOnly: boolean;
  validPath: (path: string, writing?: boolean) => Promise<string>;
  readPath: (path: string) => Promise<string>;
  searchContents: (input: ProjectSearchContentsInput) => Promise<ProjectSearchContentsResult>;
}) {
  const server = new Server(
    { name: "t3-workspace", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const abort = new AbortController();
  input.response.once("close", () => {
    abort.abort();
    void server.close();
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schemas)
      .filter(([name]) => !input.readOnly || readTools.has(name))
      .map(([name, schema]) => ({
        name,
        description: descriptions[name as keyof typeof descriptions],
        inputSchema: { ...Schema.toJsonSchemaDocument(schema).schema, type: "object" as const },
        annotations: {
          readOnlyHint: readTools.has(name),
          destructiveHint: !readTools.has(name),
          openWorldHint: name === "Bash",
        },
      })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (!Object.hasOwn(schemas, name) || (input.readOnly && !readTools.has(name)))
      return textResult("Tool unavailable for this workspace policy.", true);
    const args = request.params.arguments;
    try {
      switch (name) {
        case "Read": {
          const value = decodeRead(args);
          const path = await input.readPath(value.file_path);
          const handle = await NodeFSP.open(path, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error("Not a regular file.");
            const start = (value.offset ?? 1) - 1;
            const limit = value.limit ?? 2000;
            const bytes = Buffer.alloc(64 * 1024);
            const chunks: Buffer[] = [];
            let line = 0;
            let remaining = limit;
            let size = 0;
            let position = 0;
            let truncated = false;
            while (true) {
              abort.signal.throwIfAborted();
              extra.signal.throwIfAborted();
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
              if (bytesRead === 0) break;
              position += bytesRead;
              const chunk = bytes.subarray(0, bytesRead);
              if (chunk.includes(0)) throw new Error("Not a text file.");
              let from = 0;
              while (line < start) {
                const newline = chunk.indexOf(10, from);
                if (newline === -1) {
                  from = bytesRead;
                  break;
                }
                line++;
                from = newline + 1;
              }
              if (line < start) continue;
              let end = from;
              while (remaining > 0) {
                const newline = chunk.indexOf(10, end);
                if (newline === -1) {
                  end = bytesRead;
                  break;
                }
                remaining--;
                end = newline + 1;
              }
              const take = Math.min(end - from, MAX_OUTPUT_BYTES - size);
              chunks.push(Buffer.from(chunk.subarray(from, from + take)));
              size += take;
              if (size === MAX_OUTPUT_BYTES) {
                truncated = take < end - from || (remaining > 0 && position < stat.size);
                break;
              }
              if (remaining === 0) break;
            }
            if (line < start) return textResult("");
            const lines = Buffer.concat(chunks).toString("utf8").split("\n");
            return textResult(
              lines
                .slice(0, limit)
                .map((line, index) => `${start + index + 1}\t${line}`)
                .join("\n") + (truncated ? "\n[Output truncated at 1 MiB]" : ""),
            );
          } finally {
            await handle.close();
          }
        }
        case "Glob": {
          const value = decodeGlob(args);
          const cwd = await input.validPath(value.path ?? input.root);
          const paths: string[] = [];
          for await (const path of NodeFSP.glob(value.pattern, {
            cwd,
            exclude: ["**/node_modules/**", "**/.git/**"],
          })) {
            await input.validPath(NodePath.resolve(cwd, path));
            paths.push(NodePath.relative(input.root, NodePath.resolve(cwd, path)));
            if (paths.length === 1000) break;
          }
          return textResult(paths.join("\n"));
        }
        case "Grep": {
          const value = decodeGrep(args);
          const cwd = await input.validPath(value.path ?? input.root);
          const result = await input.searchContents({
            cwd,
            query: value.pattern,
            limit: 200,
            caseSensitive: !value["-i"],
            wholeWord: false,
            useRegex: true,
          });
          return textResult(
            JSON.stringify({
              ...result,
              matches: result.matches.map((match) => ({
                ...match,
                path: NodePath.relative(input.root, NodePath.resolve(cwd, match.path)),
              })),
            }),
          );
        }
        case "Write": {
          const value = decodeWrite(args);
          const path = await input.validPath(value.file_path, true);
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          await NodeFSP.writeFile(path, value.content);
          return textResult("File written.");
        }
        case "Edit": {
          const value = decodeEdit(args);
          const path = await input.validPath(value.file_path);
          if ((await NodeFSP.stat(path)).size > MAX_OUTPUT_BYTES)
            throw new Error("File too large to edit.");
          const content = await NodeFSP.readFile(path, "utf8");
          if (!value.old_string || !content.includes(value.old_string))
            throw new Error("Edit text not found.");
          if (
            !value.replace_all &&
            content.indexOf(value.old_string) !== content.lastIndexOf(value.old_string)
          )
            throw new Error("Edit text must be unique.");
          await NodeFSP.writeFile(
            path,
            value.replace_all
              ? content.replaceAll(value.old_string, () => value.new_string)
              : content.replace(value.old_string, () => value.new_string),
          );
          return textResult("File edited.");
        }
        case "Bash": {
          const value = decodeBash(args);
          if (value.run_in_background)
            return textResult("Use the project terminal for background commands.", true);
          const signal = AbortSignal.any([
            abort.signal,
            extra.signal,
            AbortSignal.timeout(Math.min(value.timeout ?? 120000, 120000)),
          ]);
          return await new Promise<CallToolResult>((resolve) => {
            const child = NodeChildProcess.spawn("/bin/bash", ["-lc", value.command], {
              cwd: input.root,
              stdio: ["ignore", "pipe", "pipe"],
              detached: true,
            });
            const chunks: Buffer[] = [];
            let size = 0;
            let truncated = false;
            const stop = () => {
              if (child.pid) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {}
              }
            };
            const collect = (chunk: Buffer) => {
              if (size < MAX_OUTPUT_BYTES) chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - size));
              size += chunk.length;
              if (size > MAX_OUTPUT_BYTES) {
                truncated = true;
                stop();
              }
            };
            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            signal.addEventListener("abort", stop, { once: true });
            if (signal.aborted) stop();
            child.once("error", () =>
              resolve(textResult("Could not start Codespace command.", true)),
            );
            child.once("exit", stop);
            child.once("close", (code) => {
              signal.removeEventListener("abort", stop);
              stop();
              resolve(
                textResult(
                  Buffer.concat(chunks).toString("utf8") +
                    `\n[Exit ${code ?? "interrupted"}${truncated ? "; output limit exceeded" : ""}]`,
                  code !== 0,
                ),
              );
            });
          });
        }
      }
      return textResult("Unknown workspace tool.", true);
    } catch {
      return textResult("Codespace tool failed. Check the path, input and workspace state.", true);
    }
  });
  // The pinned SDK's concrete transports allow undefined callbacks, unlike its shared interface.
  await server.connect(transport as Transport);
  await transport.handleRequest(input.request, input.response, input.payload);
}
