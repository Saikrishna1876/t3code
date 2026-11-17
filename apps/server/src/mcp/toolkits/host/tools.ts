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
      "Codespaces: list enabled host user/project/plugin skills; fresh refreshes. Read host paths via host_skills_read, never remote shell. Host workspaces use native catalog/local files. Thread credential.",
    parameters: HostSkillsListInput,
    success: HostSkillsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_skills_read", {
    ...shared,
    description:
      "Codespaces: read host skills/references. Host workspaces use local files. skill: exact path/unique name from host_skills_list/native catalog. file: relative/absolute within skill directory; default SKILL.md. Scripts need runtime/credentials; never execute host paths remotely. Thread credential.",
    parameters: HostSkillReadInput,
    success: HostSkillReadResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_mcp_list", {
    ...shared,
    description:
      "List host MCP servers; server returns tool metadata. Bridge only user-selected servers or host resources; keep other routing. Active Codex/Claude thread credential required. Missing Claude metadata: known arguments or ask; never guess.",
    parameters: HostMcpListInput,
    success: HostMcpListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("host_mcp_call", {
    ...shared,
    description:
      "Call one host MCP tool with existing host credentials/connection; first discover via host_mcp_list. Selective bridge, keep other routing; remote paths stay unchanged. Follow tool instructions/user permission for effects. Requires live full-access/default Codex/Claude thread. No recursive T3 host calls.",
    parameters: HostMcpCallInput,
    success: HostMcpCallResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
