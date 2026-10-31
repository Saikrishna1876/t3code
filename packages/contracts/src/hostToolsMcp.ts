import * as Schema from "effect/Schema";
import { ServerProviderSkill } from "./server.ts";

export const HostSkillsListInput = Schema.Struct({ fresh: Schema.optionalKey(Schema.Boolean) });
export type HostSkillsListInput = typeof HostSkillsListInput.Type;
export const HostSkillsListResult = Schema.Struct({
  execution: Schema.Literal("host"),
  skills: Schema.Array(ServerProviderSkill),
});
export type HostSkillsListResult = typeof HostSkillsListResult.Type;
export const HostSkillReadInput = Schema.Struct({
  skill: Schema.String,
  file: Schema.optionalKey(Schema.String),
});
export type HostSkillReadInput = typeof HostSkillReadInput.Type;
export const HostSkillReadResult = Schema.Struct({
  execution: Schema.Literal("host"),
  path: Schema.String,
  content: Schema.String,
});
export type HostSkillReadResult = typeof HostSkillReadResult.Type;
export const HostMcpListInput = Schema.Struct({ server: Schema.optionalKey(Schema.String) });
export type HostMcpListInput = typeof HostMcpListInput.Type;
export const HostMcpListResult = Schema.Struct({
  execution: Schema.Literal("host"),
  servers: Schema.Array(Schema.String),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      inputSchema: Schema.optionalKey(Schema.Unknown),
      annotations: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
export type HostMcpListResult = typeof HostMcpListResult.Type;
export const HostMcpCallInput = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
});
export type HostMcpCallInput = typeof HostMcpCallInput.Type;
export const HostMcpCallResult = Schema.Struct({
  execution: Schema.Literal("host"),
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(Schema.Unknown),
});
export type HostMcpCallResult = typeof HostMcpCallResult.Type;
