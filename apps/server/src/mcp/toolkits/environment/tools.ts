import {
  CodespacesListResult,
  CodespacesRunInput,
  CodespacesOperation,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
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
    "Read this server's identity and selected environment preferences. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
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
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
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
    "Create, start, connect, stop, rebuild, update or delete a GitHub Codespace for an existing project with a pushed .devcontainer configuration through this controller. Thread callers can target only their own project and its bound Codespace. Requires full-access caller and explicit Codespaces agent management enabled in project settings. Create/start may incur charges. Deletion loses unpushed files. Use a unique clientRequestId, reusing it only to retry the same request. The returned operation is durable; inspect codespaces_status for completion. Project-bound lifecycle changes require every project turn idle, including the calling turn. Ask the user to use project controls after your turn ends. Force does not bypass this guard.",
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
