import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostTools from "../../HostTools.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread:host-tools-permissions");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:host-tools"),
  requestNamespace: "provider:host-tools",
  thread: {
    threadId,
    providerSessionId: "session:host-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "host-tools-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "host-tools-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("registers four host tools and enforces thread permissions before host calls", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const shell = yield* Ref.make(liveThreadShell(threadId));
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Ref.get(shell),
      }),
      Layer.mock(HostTools.HostTools)({
        listSkills: (caller) =>
          Effect.sync(() => {
            calls.push(caller);
            return { execution: "host" as const, skills: [] };
          }),
        callMcp: (caller, input) =>
          Effect.sync(() => {
            calls.push({ caller, input });
            return { execution: "host" as const, content: [{ type: "text", text: "host result" }] };
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
        "host_mcp_call",
        "host_mcp_list",
        "host_skills_list",
        "host_skills_read",
      ]);
      const call = (
        name: string,
        invocation = scope,
        modes: Parameters<typeof liveThreadShell>[1] = {},
      ) =>
        Ref.set(shell, liveThreadShell(threadId, modes)).pipe(
          Effect.andThen(
            server.callTool({
              name,
              arguments:
                name === "host_mcp_call"
                  ? { server: "selected", tool: "lookup", arguments: {} }
                  : {},
            }),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(
        (yield* call("host_skills_list", scope, {
          interactionMode: "plan",
          runtimeMode: "approval-required",
        })).isError,
      ).not.toBe(true);
      expect(calls).toEqual([scope.thread]);
      for (const modes of [
        { interactionMode: "plan" as const },
        { runtimeMode: "approval-required" as const },
        { activeRunId: null },
      ]) {
        expect((yield* call("host_mcp_call", scope, modes)).isError).toBe(true);
      }
      expect(
        (yield* call("host_mcp_call", {
          ...scope,
          client: { sessionId: "readonly", label: "Read only", access: "read-only" },
        })).isError,
      ).toBe(true);
      expect((yield* call("host_skills_list", { ...scope, thread: undefined })).isError).toBe(true);
      expect((yield* call("host_skills_list", { ...scope, capabilities: new Set() })).isError).toBe(
        true,
      );
      expect(calls).toHaveLength(1);
      expect((yield* call("host_mcp_call")).isError).not.toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual({
        caller: scope.thread,
        input: { server: "selected", tool: "lookup", arguments: {} },
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerHostToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  }),
);
