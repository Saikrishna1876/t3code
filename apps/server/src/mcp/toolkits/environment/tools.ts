import {
  CodespacesListResult,
  CodespacesRunInput,
  CodespacesOperation,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Codespaces from "../../../codespaces/Codespaces.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Codespaces.Codespaces,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const CodespacesListTool = Tool.make("codespaces_list", {
  ...shared,
  description:
    "List this controller's GitHub Codespaces. Uses the GitHub account configured on this T3 host. Does not start compute.",
  success: CodespacesListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const CodespacesRunTool = Tool.make("codespaces_run", {
  ...shared,
  description:
    "Manage GitHub Codespaces computers. Create uses github/codespaces-blank, project optional; projects occupy separate /workspaces folders. projectId adds its committed branch without GitHub origin/devcontainer. Optional devcontainer lifecycle needs enforceable memory limits; setup failure leaves files usable. Threads may target only their project/bound Codespace. Needs full-access caller and Settings > Environments > Codespaces agent management enabled. Create/start may cost money; delete loses unpushed files. New clientRequestId per request; reuse for retries. Durable operation: codespaces_status for completion. Project-bound lifecycle needs ALL project turns idle, including yours; force cannot bypass. Ask user to use Settings or Run on > named computer after your turn.",
  parameters: Schema.Struct({ input: CodespacesRunInput }),
  success: CodespacesOperation,
}).annotate(Tool.Destructive, true);
const CodespacesStatusTool = Tool.make("codespaces_status", {
  ...shared,
  description:
    "Read controller operation progress and managed Codespace identities. Does not return credentials or change compute.",
  success: Schema.Struct({ operations: Schema.Array(CodespacesOperation) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  CodespacesListTool,
  CodespacesRunTool,
  CodespacesStatusTool,
);
