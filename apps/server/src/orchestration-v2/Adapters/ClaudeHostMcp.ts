import type { Query, SDKControlRequest } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Result = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(Schema.Unknown),
});
const decodeResult = Schema.decodeUnknownEffect(Schema.Struct({ response: Result }));
const failure = (cause: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ProviderDriverKind.make("claudeAgent"),
    detail: "Claude host MCP request failed. Check the host connection and retry.",
    payload: cause,
  });
const prefix = (server: string) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;

export function claudeHostMcp(
  query: Pick<Query, "mcpServerStatus"> &
    Partial<Pick<Query, "reconnectMcpServer">> & { readonly request?: unknown },
): ProviderAdapter.ProviderAdapterV2McpApps {
  const inventory = Effect.tryPromise({
    try: () => query.mcpServerStatus(),
    catch: failure,
  }).pipe(
    Effect.map((servers) =>
      servers.filter((server) => server.status !== "disabled" && server.source !== "sdk"),
    ),
  );
  return {
    listServers: Effect.fn("ClaudeHostMcp.listServers")(function* () {
      return [...new Set((yield* inventory).map((server) => server.name))].sort();
    }),
    listTools: Effect.fn("ClaudeHostMcp.listTools")(function* ({ server }) {
      let entry = (yield* inventory).find((item) => item.name === server);
      if (entry?.status === "pending" && query.reconnectMcpServer) {
        yield* Effect.tryPromise({
          try: () => query.reconnectMcpServer!(server),
          catch: failure,
        });
        entry = (yield* inventory).find((item) => item.name === server);
      }
      return (entry?.tools ?? []).map((tool) => ({
        ...tool,
        name: tool.name.startsWith(prefix(server))
          ? tool.name.slice(prefix(server).length)
          : tool.name,
      }));
    }),
    callTool: Effect.fn("ClaudeHostMcp.callTool")(function* (input) {
      // SDK 0.3.276 exposes mcp_call on its control transport, but not the public Query interface.
      if (!("request" in query) || typeof query.request !== "function")
        return yield* failure("Claude SDK has no MCP control transport.");
      const request = query.request as (request: SDKControlRequest["request"]) => Promise<unknown>;
      const envelope = yield* Effect.tryPromise({
        try: () =>
          request.call(query, {
            subtype: "mcp_call",
            tool: `${prefix(input.server)}${input.tool}`,
            arguments: input.arguments,
          }),
        catch: failure,
      });
      const decoded = yield* decodeResult(envelope).pipe(Effect.mapError(failure));
      const result = decoded.response;
      return {
        ...result,
        content:
          typeof result.content === "string"
            ? [{ type: "text", text: result.content }]
            : result.content,
      };
    }),
    readResource: () =>
      Effect.fail(failure("Claude host MCP resources are unavailable. Use a tool.")),
  };
}
