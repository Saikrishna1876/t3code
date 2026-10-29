import { assert, describe, it } from "@effect/vitest";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { claudeHostMcp } from "./ClaudeHostMcp.ts";

const providerThread = {} as OrchestrationV2ProviderThread;
const statuses: McpServerStatus[] = [
  {
    name: "notes.host",
    status: "connected",
    tools: [{ name: "mcp__notes_host__lookup", description: "Read a note" }],
  },
  { name: "disabled", status: "disabled" },
  { name: "in-process", status: "connected", source: "sdk" },
];

describe("Claude host MCP", () => {
  it.effect("lists native servers and forwards one call without starting a model turn", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const result = {
        content: [{ type: "text", text: "Friday" }],
        structuredContent: { day: "Friday" },
        _meta: { example: 1 },
      };
      const query = {
        mcpServerStatus: async () => statuses,
        request: async (input: unknown) => {
          calls.push(input);
          return { response: result };
        },
      };
      const bridge = claudeHostMcp(query);
      assert.deepEqual(yield* bridge.listServers!({ providerThread }), ["notes.host"]);
      assert.deepEqual(yield* bridge.listTools({ providerThread, server: "notes.host" }), [
        { name: "lookup", description: "Read a note" },
      ]);
      assert.deepEqual(
        yield* bridge.callTool({
          providerThread,
          server: "notes.host",
          tool: "lookup",
          arguments: { title: "Release" },
        }),
        result,
      );
      assert.deepEqual(calls, [
        { subtype: "mcp_call", tool: "mcp__notes_host__lookup", arguments: { title: "Release" } },
      ]);
    }),
  );
  it.effect("connects only the selected pending server before discovering tools", () =>
    Effect.gen(function* () {
      let connected = false;
      const reconnects: string[] = [];
      const bridge = claudeHostMcp({
        mcpServerStatus: async () =>
          connected
            ? statuses
            : [
                { name: "notes.host", status: "pending" },
                { name: "other", status: "pending" },
              ],
        reconnectMcpServer: async (server) => {
          reconnects.push(server);
          connected = true;
        },
      });
      assert.deepEqual(yield* bridge.listTools({ providerThread, server: "notes.host" }), [
        { name: "lookup", description: "Read a note" },
      ]);
      assert.deepEqual(reconnects, ["notes.host"]);
    }),
  );
  it.effect("normalizes text responses and preserves tool errors", () =>
    Effect.gen(function* () {
      const bridge = claudeHostMcp({
        mcpServerStatus: async () => statuses,
        request: async () => ({ response: { content: "Failed", isError: true } }),
      });
      assert.deepEqual(
        yield* bridge.callTool({
          providerThread,
          server: "notes.host",
          tool: "lookup",
          arguments: {},
        }),
        {
          content: [{ type: "text", text: "Failed" }],
          isError: true,
        },
      );
    }),
  );
  it.effect("fails closed when SDK control transport is unavailable or malformed", () =>
    Effect.gen(function* () {
      for (const query of [
        { mcpServerStatus: async () => statuses },
        { mcpServerStatus: async () => statuses, request: async () => ({ response: {} }) },
      ]) {
        const result = yield* claudeHostMcp(query)
          .callTool({ providerThread, server: "notes.host", tool: "lookup", arguments: {} })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
    }),
  );
});
