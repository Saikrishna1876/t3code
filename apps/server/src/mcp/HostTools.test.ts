import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostTools from "./HostTools.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const caller = {
  threadId: ThreadId.make("thread:host-tools"),
  providerSessionId: "session:host-tools",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const hostCwd = "/home/user/project";
const providerThread = {
  providerSessionId: caller.providerSessionId,
  providerInstanceId: caller.providerInstanceId,
} as OrchestrationV2ProviderThread;

function dependencies(input: {
  skills?: ReadonlyArray<ServerProviderSkill>;
  provider?: "codex" | "claude";
  mcpApps?: ProviderAdapter.ProviderAdapterV2McpApps;
  live?: boolean;
  instanceId?: ProviderInstanceId;
  sessionId?: string;
  shell?: () => OrchestrationV2ThreadShell;
  onDiscovery?: (cwd: string, fresh: boolean) => void;
}) {
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: liveThreadShell(caller.threadId),
          providerThreads: [
            {
              ...providerThread,
              providerInstanceId: ProviderInstanceId.make(input.provider ?? "codex"),
              providerSessionId: input.sessionId ?? caller.providerSessionId,
            },
          ],
        } as never),
      getThreadShell: () => Effect.sync(() => input.shell?.() ?? liveThreadShell(caller.threadId)),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ workspaceRoot: hostCwd } as never),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () =>
        Effect.succeed(
          input.live === false
            ? Option.none()
            : Option.some({
                instanceId: input.instanceId ?? ProviderInstanceId.make(input.provider ?? "codex"),
                ...(input.mcpApps === undefined ? {} : { mcpApps: input.mcpApps }),
              } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
        ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshWorkspaceSnapshot: ({ cwd, fresh }) =>
        Effect.sync(() => {
          input.onDiscovery?.(cwd, fresh ?? false);
          return [
            {
              instanceId: ProviderInstanceId.make(input.provider ?? "codex"),
              enabled: true,
              driver: ProviderDriverKind.make(input.provider ?? "codex"),
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-10-29T00:00:00Z",
              models: [],
              slashCommands: [],
              skills: [{ name: "wrong-workspace", path: "/wrong/SKILL.md", enabled: true }],
              workspaceSnapshots: [
                {
                  cwd: hostCwd,
                  checkedAt: "2026-10-29T00:00:00Z",
                  slashCommands: [],
                  skills: input.skills ?? [],
                },
              ],
            } satisfies ServerProvider,
          ];
        }),
    }),
  );
}

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-host-skills-" })
    .pipe(Effect.flatMap(fs.realPath));
  const directory = path.join(root, "skill");
  yield* fs.makeDirectory(path.join(directory, "references"), { recursive: true });
  const entry = path.join(directory, "SKILL.md");
  yield* fs.writeFileString(entry, "# Host skill\nRead references/setup.md.");
  yield* fs.writeFileString(path.join(directory, "references/setup.md"), "Host reference content");
  const outside = path.join(root, "private.txt");
  yield* fs.writeFileString(outside, "Outside skill");
  yield* fs.symlink(outside, path.join(directory, "escape.md"));
  return {
    fs,
    path,
    directory,
    entry,
    outside,
    skill: { name: "host-skill", path: entry, enabled: true },
  };
});

describe("HostTools skills", () => {
  it.effect("reads Claude skills from the host provider catalog", () =>
    Effect.gen(function* () {
      const { skill } = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* HostTools.HostTools;
        const claudeCaller = { ...caller, providerInstanceId: ProviderInstanceId.make("claude") };
        assert.deepEqual((yield* service.listSkills(claudeCaller, {})).skills, [skill]);
        assert.equal(
          (yield* service.readSkill(claudeCaller, { skill: skill.name })).content,
          "# Host skill\nRead references/setup.md.",
        );
      }).pipe(
        Effect.provide(
          HostTools.layer.pipe(
            Layer.provide(dependencies({ provider: "claude", skills: [skill] })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("discovers host workspace skills and reads their entry and references", () =>
    Effect.gen(function* () {
      const { skill, entry, directory, path } = yield* fixture;
      const discovered: Array<{ cwd: string; fresh: boolean }> = [];
      yield* Effect.gen(function* () {
        const service = yield* HostTools.HostTools;
        assert.deepEqual(yield* service.listSkills(caller, { fresh: true }), {
          execution: "host",
          skills: [skill],
        });
        assert.deepEqual(yield* service.readSkill(caller, { skill: entry }), {
          execution: "host",
          path: entry,
          content: "# Host skill\nRead references/setup.md.",
        });
        for (const file of ["references/setup.md", path.join(directory, "references/setup.md")]) {
          assert.equal(
            (yield* service.readSkill(caller, { skill: skill.name, file })).content,
            "Host reference content",
          );
        }
      }).pipe(
        Effect.provide(
          HostTools.layer.pipe(
            Layer.provide(
              dependencies({
                skills: [skill, { ...skill, name: "disabled", enabled: false }],
                onDiscovery: (cwd, fresh) => {
                  discovered.push({ cwd, fresh });
                },
              }),
            ),
          ),
        ),
      );
      assert.isTrue(discovered.every(({ cwd }) => cwd === hostCwd));
      assert.deepEqual(discovered[0], { cwd: hostCwd, fresh: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts directory catalog entries and rejects unknown or ambiguous names", () =>
    Effect.gen(function* () {
      const { skill, directory, entry } = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* HostTools.HostTools;
        assert.equal((yield* service.readSkill(caller, { skill: directory })).path, entry);
        for (const name of [skill.name, "missing"]) {
          assert.equal(
            (yield* Effect.flip(service.readSkill(caller, { skill: name }))).code,
            "invalid_request",
          );
        }
      }).pipe(
        Effect.provide(
          HostTools.layer.pipe(
            Layer.provide(dependencies({ skills: [skill, { ...skill, path: directory }] })),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects traversal, external absolute paths, symlink escape, binary and oversized files",
    () =>
      Effect.gen(function* () {
        const { fs, path, skill, directory, outside } = yield* fixture;
        yield* fs.writeFileString(path.join(directory, "binary"), "text\0data");
        yield* fs.writeFileString(path.join(directory, "large"), "x".repeat(1_048_577));
        yield* Effect.gen(function* () {
          const service = yield* HostTools.HostTools;
          for (const file of [
            "../private.txt",
            outside,
            "escape.md",
            "binary",
            "large",
            "references",
            "missing.md",
          ]) {
            assert.equal(
              (yield* Effect.flip(service.readSkill(caller, { skill: skill.name, file }))).code,
              "invalid_request",
            );
          }
        }).pipe(
          Effect.provide(HostTools.layer.pipe(Layer.provide(dependencies({ skills: [skill] })))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("HostTools selective MCP", () => {
  it.effect(
    "lists schemas and forwards only the named server/tool with result content intact",
    () =>
      Effect.gen(function* () {
        const calls: Array<unknown> = [];
        const tool = {
          name: "lookup",
          description: "Host lookup",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        };
        const output = {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { value: 7 },
          isError: true,
          _meta: { progress: 1 },
        };
        const mcpApps: ProviderAdapter.ProviderAdapterV2McpApps = {
          listServers: () => Effect.succeed(["host-files", "other-server", "t3-code"]),
          listTools: () => Effect.succeed([tool, { name: "host_mcp_call" }]),
          callTool: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return output;
            }),
          readResource: () => Effect.succeed({ contents: [] }),
        };
        yield* Effect.gen(function* () {
          const service = yield* HostTools.HostTools;
          assert.deepEqual(yield* service.listMcp(caller, {}), {
            execution: "host",
            servers: ["host-files", "other-server"],
            tools: [],
          });
          assert.deepEqual(yield* service.listMcp(caller, { server: "host-files" }), {
            execution: "host",
            servers: ["host-files"],
            tools: [tool],
          });
          assert.equal(calls.length, 0);
          assert.deepEqual(
            yield* service.callMcp(caller, {
              server: "host-files",
              tool: "lookup",
              arguments: { name: "project" },
            }),
            { execution: "host", ...output },
          );
          assert.deepEqual(calls, [
            {
              providerThread,
              server: "host-files",
              tool: "lookup",
              arguments: { name: "project" },
            },
          ]);
          for (const [server, name] of [
            ["unknown", "lookup"],
            ["t3-code", "lookup"],
            ["host-files", "missing"],
            ["host-files", "host_mcp_call"],
          ]) {
            assert.equal(
              (yield* Effect.flip(
                service.callMcp(caller, { server: server!, tool: name!, arguments: {} }),
              )).code,
              "invalid_request",
            );
          }
          assert.equal(calls.length, 1);
        }).pipe(Effect.provide(HostTools.layer.pipe(Layer.provide(dependencies({ mcpApps })))));
      }),
  );

  it.effect("rechecks live caller modes after MCP inventory before executing", () =>
    Effect.gen(function* () {
      let shell = liveThreadShell(caller.threadId);
      let calls = 0;
      const mcpApps: ProviderAdapter.ProviderAdapterV2McpApps = {
        listServers: () => Effect.succeed(["host-files"]),
        listTools: () =>
          Effect.sync(() => {
            shell = liveThreadShell(caller.threadId, { interactionMode: "plan" });
            return [{ name: "lookup" }];
          }),
        callTool: () =>
          Effect.sync(() => {
            calls++;
            return { content: [] };
          }),
        readResource: () => Effect.succeed({ contents: [] }),
      };
      yield* Effect.gen(function* () {
        const service = yield* HostTools.HostTools;
        assert.equal(
          (yield* Effect.flip(
            service.callMcp(caller, { server: "host-files", tool: "lookup", arguments: {} }),
          )).code,
          "capability_denied",
        );
        assert.equal(calls, 0);
      }).pipe(
        Effect.provide(
          HostTools.layer.pipe(Layer.provide(dependencies({ mcpApps, shell: () => shell }))),
        ),
      );
    }),
  );

  it.effect("reports unsupported providers without substituting another connection", () =>
    Effect.gen(function* () {
      const service = yield* HostTools.HostTools;
      assert.include(
        (yield* Effect.flip(service.listMcp(caller, {}))).message,
        "does not expose a host MCP bridge",
      );
    }).pipe(Effect.provide(HostTools.layer.pipe(Layer.provide(dependencies({}))))),
  );

  it.effect.each([
    ["stopped", { live: false }],
    ["another provider", { instanceId: ProviderInstanceId.make("other") }],
    ["another session", { sessionId: "session:other" }],
  ] as const)("refuses %s callers before host discovery", ([_label, input]) =>
    Effect.gen(function* () {
      const service = yield* HostTools.HostTools;
      assert.equal((yield* Effect.flip(service.listSkills(caller, {}))).code, "invalid_request");
      assert.equal((yield* Effect.flip(service.listMcp(caller, {}))).code, "invalid_request");
    }).pipe(Effect.provide(HostTools.layer.pipe(Layer.provide(dependencies(input))))),
  );
});
