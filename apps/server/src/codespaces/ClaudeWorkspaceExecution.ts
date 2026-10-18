import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { CodespacesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { CodespacesWorkspace } from "./CodespacesWorkspace.ts";

const localWorkspaceTools = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Agent",
  "Task",
  "Skill",
  "LSP",
];

export const claudeWorkspaceExecution = Effect.fn("claudeWorkspaceExecution")(function* (
  workspace: CodespacesWorkspace["Service"] | undefined,
  cwd: string | null,
  readOnly: boolean,
) {
  const target = workspace && cwd ? yield* workspace.lookup(cwd) : null;
  if (!target) return undefined;
  if (!target.executor || !target.remoteCwd)
    return yield* new CodespacesError({
      code: "conflict",
      message: "Resume this project's Codespace before starting Claude.",
    });
  const names = readOnly
    ? ["Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
  return {
    mcpServers: {
      "t3-workspace": {
        type: "http",
        url: target.executor.workerUrl + (readOnly ? "/claude/mcp/read-only" : "/claude/mcp"),
        headers: { Authorization: `Bearer ${target.executor.token}` },
        timeout: 150000,
        alwaysLoad: true,
      },
    },
    tools: readOnly
      ? ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ToolSearch"]
      : [
          "AskUserQuestion",
          "EnterPlanMode",
          "ExitPlanMode",
          "ToolSearch",
          "TodoWrite",
          "TaskCreate",
          "TaskUpdate",
          "TaskGet",
          "TaskList",
          "WebSearch",
          "WebFetch",
        ],
    disallowedTools: localWorkspaceTools,
    toolAliases: Object.fromEntries(names.map((name) => [name, `mcp__t3-workspace__${name}`])),
    // Headless dontAsk sessions otherwise deny even the remote read tools.
    allowedTools: ["Read", "Glob", "Grep"].map((name) => `mcp__t3-workspace__${name}`),
    settingSources: [],
    instructions: `\nWorkspace execution is in GitHub Codespace ${target.name}, rooted at ${target.remoteCwd}. Use t3-workspace MCP tools for workspace operations. Local project files are not the active workspace. Read the remote CLAUDE.md and AGENTS.md instructions before working. Native local workspace tools, skills and subagents are unavailable for this target. ${readOnly ? "This workspace is read-only. Use Read, Glob and Grep. Shell commands and file edits are unavailable." : "Use Bash for commands, including searches that need extra options. Background shell commands are unsupported; use the project terminal for persistent servers."}`,
  } satisfies Pick<
    Options,
    "mcpServers" | "tools" | "disallowedTools" | "toolAliases" | "allowedTools" | "settingSources"
  > & { instructions: string };
});
