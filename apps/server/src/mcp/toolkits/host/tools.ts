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
      "Codespaces only; host workspaces use native catalog/local files. List enabled host user/project/plugin skills. Read host paths with host_skills_read, never remote shell. fresh refreshes discovery. Needs thread credential.",
    parameters: HostSkillsListInput,
    success: HostSkillsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("host_skills_read", {
    ...shared,
    description:
      "Codespaces only; host workspaces read local files. Read host skill/references. skill: exact path or unique name from host_skills_list/native catalog. file: relative or absolute inside skill directory; default SKILL.md. Scripts need runtime/credentials; never execute host paths remotely. Needs thread credential.",
    parameters: HostSkillReadInput,
    success: HostSkillReadResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("host_mcp_list", {
    ...shared,
    description:
      "List host MCP servers; pass server for tool metadata. No rerouting. Bridge only user-selected host servers or tools needing host resources. Keep other routing. Active Codex/Claude only. Missing Claude metadata: use known arguments or ask, never guess. Needs thread credential.",
    parameters: HostMcpListInput,
    success: HostMcpListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("host_mcp_call", {
    ...shared,
    description:
      "Call one host MCP tool with existing host connection/credentials; discover metadata with host_mcp_list first. Selective calls; keep other routing. No remote path translation. Follow tool instructions/user authorization for side effects. Needs live full-access/default Codex/Claude thread. No recursive T3 host bridge calls.",
    parameters: HostMcpCallInput,
    success: HostMcpCallResult,
  }).annotate(Tool.Destructive, true),
);
