import {
  OrchestratorMcpFailure,
  ProviderSessionId,
  type ProviderInstanceId,
  type ThreadId,
  type HostSkillsListInput,
  type HostSkillsListResult,
  type HostSkillReadInput,
  type HostSkillReadResult,
  type HostMcpListInput,
  type HostMcpListResult,
  type HostMcpCallInput,
  type HostMcpCallResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { isLiveCallerShell } from "./OrchestratorMcpService.ts";

interface HostToolsCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export class HostTools extends Context.Service<
  HostTools,
  {
    readonly listSkills: (
      caller: HostToolsCaller,
      input: HostSkillsListInput,
    ) => Effect.Effect<HostSkillsListResult, OrchestratorMcpFailure>;
    readonly readSkill: (
      caller: HostToolsCaller,
      input: HostSkillReadInput,
    ) => Effect.Effect<HostSkillReadResult, OrchestratorMcpFailure>;
    readonly listMcp: (
      caller: HostToolsCaller,
      input: HostMcpListInput,
    ) => Effect.Effect<HostMcpListResult, OrchestratorMcpFailure>;
    readonly callMcp: (
      caller: HostToolsCaller,
      input: HostMcpCallInput,
    ) => Effect.Effect<HostMcpCallResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/HostTools") {}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The host request failed. Check this provider's host connection and retry.",
  });
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const isBridgeServer = (name: string) => ["t3-code", "t3_code"].includes(name);
const isBridgeTool = (name: string) =>
  ["host_skills_list", "host_skills_read", "host_mcp_list", "host_mcp_call"].includes(name);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;

  const resolve = Effect.fn("HostTools.resolve")(function* (caller: HostToolsCaller) {
    const records = yield* threads
      .getThreadRecords(caller.threadId, ["providerThreads"])
      .pipe(Effect.mapError(unavailable));
    const providerThread = records.providerThreads.find(
      (entry) =>
        entry.providerSessionId === caller.providerSessionId &&
        entry.providerInstanceId === caller.providerInstanceId,
    );
    if (!providerThread || records.thread.deletedAt !== null)
      return yield* invalid("The calling provider no longer owns this thread.");
    const runtime = yield* sessions
      .get(ProviderSessionId.make(caller.providerSessionId))
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(runtime) || runtime.value.instanceId !== caller.providerInstanceId)
      return yield* invalid("The calling host provider session has stopped.");
    return { records, providerThread, runtime: runtime.value };
  });
  const skills = Effect.fn("HostTools.skills")(function* (caller: HostToolsCaller, fresh = false) {
    const { records } = yield* resolve(caller);
    const project = yield* projects
      .get(records.thread.projectId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(project))
      return yield* invalid("The calling project no longer exists on the host.");
    const cwd = records.thread.worktreePath ?? project.value.workspaceRoot;
    const inventory = yield* providers.refreshWorkspaceSnapshot({
      instanceId: caller.providerInstanceId,
      cwd,
      fresh,
    });
    const provider = inventory.find((entry) => entry.instanceId === caller.providerInstanceId);
    if (!provider?.enabled) return yield* invalid("The calling host provider is unavailable.");
    return (
      provider.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills ?? provider.skills
    ).filter((skill) => skill.enabled);
  });
  const listSkills = Effect.fn("HostTools.listSkills")(function* (
    caller: HostToolsCaller,
    input: HostSkillsListInput,
  ) {
    return { execution: "host" as const, skills: yield* skills(caller, input.fresh) };
  });
  const readSkill = Effect.fn("HostTools.readSkill")(function* (
    caller: HostToolsCaller,
    input: HostSkillReadInput,
  ) {
    const inventory = yield* skills(caller);
    const matches = inventory.filter(
      (entry) => entry.path === input.skill || entry.name === input.skill,
    );
    if (matches.length !== 1)
      return yield* invalid(
        matches.length
          ? "Skill name is ambiguous. Use its exact host path from host_skills_list."
          : "Skill is not enabled in this host provider's catalog. Refresh host_skills_list before retrying.",
      );
    const skill = matches[0]!;
    return yield* Effect.gen(function* () {
      const info = yield* fs.stat(skill.path);
      const entry = info.type === "Directory" ? path.join(skill.path, "SKILL.md") : skill.path;
      const root = yield* fs.realPath(path.dirname(entry));
      const target = yield* fs.realPath(
        input.file ? path.resolve(path.dirname(entry), input.file) : entry,
      );
      const relative = path.relative(root, target);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
        return yield* invalid("Read only files inside this host skill's directory.");
      const targetInfo = yield* fs.stat(target);
      if (targetInfo.type !== "File" || Number(targetInfo.size) > 1_048_576)
        return yield* invalid("Skill file must be a regular text file no larger than 1 MiB.");
      const content = yield* fs.readFileString(target);
      if (content.includes("\0"))
        return yield* invalid(
          "This host skill file is binary. Read its text instructions or references instead.",
        );
      return { execution: "host" as const, path: target, content };
    }).pipe(
      Effect.mapError((cause) =>
        isMcpFailure(cause)
          ? cause
          : invalid(
              "Could not read this host skill file. Refresh the catalog and check the file exists.",
            ),
      ),
    );
  });
  const mcp = Effect.fn("HostTools.mcp")(function* (caller: HostToolsCaller) {
    const resolved = yield* resolve(caller);
    const bridge = resolved.runtime.mcpApps;
    if (!bridge?.listServers)
      return yield* invalid(
        "This provider does not expose a host MCP bridge. Use its native MCP tools; no calls were rerouted.",
      );
    const servers = (yield* bridge
      .listServers({ providerThread: resolved.providerThread })
      .pipe(Effect.mapError(unavailable))).filter((name) => !isBridgeServer(name));
    return { ...resolved, bridge, servers };
  });
  const listMcp = Effect.fn("HostTools.listMcp")(function* (
    caller: HostToolsCaller,
    input: HostMcpListInput,
  ) {
    const resolved = yield* mcp(caller);
    if (!input.server) return { execution: "host" as const, servers: resolved.servers, tools: [] };
    if (!resolved.servers.includes(input.server))
      return yield* invalid("Select a configured host MCP server from host_mcp_list.");
    const tools = yield* resolved.bridge
      .listTools({ providerThread: resolved.providerThread, server: input.server })
      .pipe(Effect.mapError(unavailable));
    return {
      execution: "host" as const,
      servers: [input.server],
      tools: tools
        .filter((tool) => !isBridgeTool(tool.name))
        .map(({ name, description, inputSchema, annotations }) => ({
          name,
          ...(description === undefined ? {} : { description }),
          ...(inputSchema === undefined ? {} : { inputSchema }),
          ...(annotations === undefined ? {} : { annotations }),
        })),
    };
  });
  const callMcp = Effect.fn("HostTools.callMcp")(function* (
    caller: HostToolsCaller,
    input: HostMcpCallInput,
  ) {
    const resolved = yield* mcp(caller);
    if (!resolved.servers.includes(input.server) || isBridgeTool(input.tool))
      return yield* invalid(
        "Select a configured host MCP server and tool. Recursive T3 host bridge calls are unavailable.",
      );
    const tools = yield* resolved.bridge
      .listTools({ providerThread: resolved.providerThread, server: input.server })
      .pipe(Effect.mapError(unavailable));
    if (!tools.some((tool) => tool.name === input.tool))
      return yield* invalid("This tool is not available on the selected host MCP server.");
    yield* resolve(caller);
    const shell = yield* threads.getThreadShell(caller.threadId).pipe(Effect.mapError(unavailable));
    if (
      !shell ||
      shell.deletedAt !== null ||
      !isLiveCallerShell(shell, caller.providerInstanceId) ||
      shell.runtimeMode !== "full-access" ||
      shell.interactionMode !== "default"
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Host MCP calls require a live full-access/default thread.",
      });
    }
    const result = yield* resolved.bridge
      .callTool({
        providerThread: resolved.providerThread,
        server: input.server,
        tool: input.tool,
        arguments: input.arguments,
      })
      .pipe(Effect.mapError(unavailable));
    return { execution: "host" as const, ...result };
  });
  return HostTools.of({ listSkills, readSkill, listMcp, callMcp });
});

export const layer = Layer.effect(HostTools, make);
