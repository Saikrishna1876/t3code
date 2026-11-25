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
import { McpSchema, Tool, Toolkit } from "effect/ai";

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
      "Codespaces: list enabled host skills. fresh refreshes. Read through host_skills_read. Needs thread credential.",
    parameters: HostSkillsListInput,
    success: HostSkillsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_skills_read", {
    ...shared,
    description:
      "Codespaces: read host skill or reference. skill: exact path or unique name from host_skills_list/catalog. file inside skill dir, default SKILL.md. Never run host paths remotely.",
    parameters: HostSkillReadInput,
    success: HostSkillReadResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_mcp_list", {
    ...shared,
    description:
      "List host MCP servers/tools for live Codex/Claude. Bridge only user-selected servers/resources. Keep other routing. Missing Claude schema: use known arguments or ask.",
    parameters: HostMcpListInput,
    success: HostMcpListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_mcp_call", {
    ...shared,
    description:
      "Call one host MCP tool via host_mcp_list with existing credentials. Keep other routing, remote paths, tool instructions and permissions. Requires live full-access/default Codex/Claude. No recursive T3 calls.",
    parameters: HostMcpCallInput,
    success: HostMcpCallResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
