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
  description: "Read server identity/preferences. Models: orchestrator_capabilities.",
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
    "Update environment preferences, live full-access/default only. Omitted fields stay; empty customInstructions clears.",
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
  description: "List controller's Codespaces via host GitHub account without starting compute.",
  success: CodespacesListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const CodespacesRunTool = Tool.make("codespaces_run", {
  ...shared,
  description:
    "Manage Codespaces. Create uses github/codespaces-blank; projectId transfers committed branch to /workspaces without origin/devcontainer. Setup needs memory limits; failure keeps files. Needs full-access + Codespaces agent management. Create/start costs; delete loses unpushed files. Reuse clientRequestId only on retry; await codespaces_status. All turns idle, even with force.",
  parameters: Schema.Struct({ input: CodespacesRunInput }),
  success: CodespacesOperation,
}).annotate(Tool.Destructive, true);
const CodespacesStatusTool = Tool.make("codespaces_status", {
  ...shared,
  description:
    "Read operation progress and managed Codespace identities. No credentials or compute changes.",
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
