import {
  HostSkillsListInput,
  HostSkillsListResult,
  HostSkillReadInput,
  HostSkillReadResult,
  HostMcpListInput,
  HostMcpListResult,
  HostMcpCallInput,
  HostMcpCallResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as HostTools from "../../HostTools.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    HostTools.HostTools,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
export const HostToolkit = Toolkit.make(
  Tool.make("host_skills_list", {
    ...shared,
    description:
      "List enabled skills from the calling provider's T3 host, including user, project and plugin skills. All skills are sourced from the host even when project commands run in a Codespace. Returns host paths; read them with host_skills_read, never a remote shell. fresh refreshes discovery. Thread credential required.",
    parameters: HostSkillsListInput,
    success: HostSkillsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("host_skills_read", {
    ...shared,
    description:
      "Read a skill or its text references directly from the T3 host. skill is the exact path or unique name from host_skills_list or the native skill catalog. Omit file for SKILL.md; file can be relative to the skill directory or an absolute host path inside it. This reads instructions; scripts still need their declared runtime and credentials. Do not execute host paths in a Codespace. Thread credential required.",
    parameters: HostSkillReadInput,
    success: HostSkillReadResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("host_mcp_list", {
    ...shared,
    description:
      "Discover configured MCP servers on the calling provider's T3 host. Pass one server to get its tool descriptions and input schemas. Discovery does not reroute any tools. Use this bridge only for a server the user selects for host execution or a tool that needs host resources. Other MCP tools keep their existing execution location. Currently supported by active Codex and Claude sessions; other providers report unsupported. Claude may omit descriptions and input schemas; use known arguments or ask the user, never guess. Thread credential required.",
    parameters: HostMcpListInput,
    success: HostMcpListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("host_mcp_call", {
    ...shared,
    description:
      "Call exactly one named tool on a configured host MCP server using the calling provider's existing host connection and credentials. Discover its tool metadata with host_mcp_list first. Host execution is selective per call; do not send every MCP request through this bridge. Remote workspace paths are not translated to host files. Tool may have external side effects; follow its instructions and the user's authorization. Requires a live full-access/default thread. Currently supported by Codex and Claude. Never use for recursive T3 host bridge calls.",
    parameters: HostMcpCallInput,
    success: HostMcpCallResult,
  }).annotate(Tool.Destructive, true),
);
