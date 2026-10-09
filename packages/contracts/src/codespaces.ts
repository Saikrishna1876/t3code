import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodespaceName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
);
export const CodespaceRepository = Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/));
export const CodespacesRequestId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/),
);

export class CodespacesError extends Schema.TaggedError<CodespacesError>()("CodespacesError", {
  code: Schema.Literals([
    "authentication",
    "permission",
    "quota",
    "busy",
    "configuration",
    "github",
    "bootstrap",
    "storage",
    "conflict",
  ]),
  message: Schema.String,
}) {}

/** The controller must use a fork-owned archive or an explicitly installed remote script. */
export const CodespacesConfiguration = Schema.Struct({
  releaseBaseUrl: Schema.String,
  archiveVersion: Schema.String,
  remoteScriptPath: Schema.String,
  /** Optional reverse-proxy URL with {name} and/or {port}; never a client's loopback URL. */
  publicUrlTemplate: Schema.String,
  /** Explicit opt-in to listen on the controller's private network instead of loopback. */
  networkAccess: Schema.Boolean,
  /** Explicit authorization for agents to manage billable Codespaces through MCP. */
  agentAccessEnabled: Schema.Boolean,
});
export type CodespacesConfiguration = typeof CodespacesConfiguration.Type;

export const Codespace = Schema.Struct({
  id: Schema.Int,
  name: CodespaceName,
  displayName: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
  state: Schema.String,
  machine: Schema.String,
  webUrl: Schema.String,
  idleTimeoutMinutes: Schema.NullOr(Schema.Int),
  retentionMinutes: Schema.NullOr(Schema.Int),
});
export type Codespace = typeof Codespace.Type;
export const CodespacesOptionsInput = Schema.Struct({
  repository: CodespaceRepository,
  ref: Schema.optionalKey(TrimmedNonEmptyString),
});
export const CodespacesOptions = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      displayName: Schema.String,
      cpus: Schema.Int,
      memoryBytes: Schema.Number,
    }),
  ),
  devcontainers: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
});
export type CodespacesOptions = typeof CodespacesOptions.Type;

const targetFields = { name: CodespaceName };
const requestFields = {
  clientRequestId: CodespacesRequestId,
  projectId: Schema.optionalKey(ProjectId),
};
export const CodespacesRunInput = Schema.Union([
  Schema.Struct({
    ...requestFields,
    action: Schema.Literal("create"),
    repository: CodespaceRepository,
    ref: Schema.optionalKey(TrimmedNonEmptyString),
    machine: TrimmedNonEmptyString,
    devcontainerPath: Schema.optionalKey(TrimmedNonEmptyString),
    idleTimeoutMinutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 240 })),
    retentionDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
  }),
  Schema.Struct({
    ...requestFields,
    ...targetFields,
    action: Schema.Literals(["start", "connect", "stop", "rebuild", "delete"]),
    force: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...requestFields,
    ...targetFields,
    action: Schema.Literal("update"),
    displayName: Schema.optionalKey(TrimmedNonEmptyString),
    machine: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type CodespacesRunInput = typeof CodespacesRunInput.Type;
export const CodespacesOperation = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  clientRequestId: CodespacesRequestId,
  action: Schema.Literals(["create", "start", "connect", "stop", "rebuild", "delete", "update"]),
  name: Schema.NullOr(CodespaceName),
  status: Schema.Literals(["running", "succeeded", "failed"]),
  stage: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
});
export type CodespacesOperation = typeof CodespacesOperation.Type;
export const CodespacesManagedEnvironment = Schema.Struct({
  name: CodespaceName,
  account: Schema.String,
  codespaceId: Schema.Int,
  environmentId: Schema.NullOr(EnvironmentId),
  localPort: Schema.Int,
  remotePort: Schema.Int,
  workspacePath: Schema.String,
  connected: Schema.Boolean,
});
export type CodespacesManagedEnvironment = typeof CodespacesManagedEnvironment.Type;
export const CodespacesSnapshot = Schema.Struct({
  bindingRevision: Schema.optionalKey(Schema.Number),
  configuration: CodespacesConfiguration,
  operations: Schema.Array(CodespacesOperation),
  environments: Schema.Array(CodespacesManagedEnvironment),
});
export type CodespacesSnapshot = typeof CodespacesSnapshot.Type;
export const CodespacesListResult = Schema.Struct({
  account: Schema.String,
  codespaces: Schema.Array(Codespace),
});
export const CodespacesPairInput = Schema.Struct({ name: CodespaceName, remote: Schema.Boolean });
export const CodespacesPairResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  pairingCode: Schema.String,
  workspacePath: Schema.String,
});

export type CodespacesPairResult = typeof CodespacesPairResult.Type;

export const CodespacesProjectInput = Schema.Struct({ projectId: ProjectId });
export const CodespacesBindInput = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NullOr(CodespaceName),
});
export const CodespacesProject = Schema.Struct({
  projectId: ProjectId,
  eligible: Schema.Boolean,
  reason: Schema.String,
  repository: Schema.String,
  ref: Schema.String,
  devcontainerPaths: Schema.Array(Schema.String),
  name: Schema.NullOr(CodespaceName),
  connected: Schema.Boolean,
});
export type CodespacesProject = typeof CodespacesProject.Type;
