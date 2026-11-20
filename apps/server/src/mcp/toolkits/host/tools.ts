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
      "Codespaces: list enabled host skills; `fresh` refreshes. Read via `host_skills_read`, never remote shell. Needs thread credential.",
    parameters: HostSkillsListInput,
    success: HostSkillsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_skills_read", {
    ...shared,
    description:
      "Codespaces: read host skills/references. `skill`: exact path or unique name from `host_skills_list`/native catalog. `file`: path within skill dir, default SKILL.md. Never run host paths remotely.",
    parameters: HostSkillReadInput,
    success: HostSkillReadResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_mcp_list", {
    ...shared,
    description:
      "List host MCP servers; server returns tool metadata. Bridge only user-selected servers/resources; keep other routing. Needs live Codex/Claude thread credential. Missing Claude metadata: use known arguments or ask.",
    parameters: HostMcpListInput,
    success: HostMcpListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_mcp_call", {
    ...shared,
    description:
      "Call one host MCP tool with existing credentials; discover via `host_mcp_list`. Selective bridge; keep other routing; remote paths unchanged. Follow tool instructions and user permission. Needs live full-access/default Codex/Claude thread. No recursive T3 host calls.",
    parameters: HostMcpCallInput,
    success: HostMcpCallResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
