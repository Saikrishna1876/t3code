import * as Effect from "effect/Effect";
import * as HostTools from "../../HostTools.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, assertLiveCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HostToolkit } from "./tools.ts";

const caller = Effect.gen(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return (yield* McpInvocationContext.requireThreadScope(context.scope, "Host tools")).thread;
});
export const layer = McpToolAccess.toLayer(HostToolkit, {
  host_skills_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* HostTools.HostTools).listSkills(yield* caller, input);
    }),
  ),
  host_skills_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* HostTools.HostTools).readSkill(yield* caller, input);
    }),
  ),
  host_mcp_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* HostTools.HostTools).listMcp(yield* caller, input);
    }),
  ),
  host_mcp_call: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* check;
      return yield* (yield* HostTools.HostTools).callMcp(yield* caller, input);
    }),
  ),
});
