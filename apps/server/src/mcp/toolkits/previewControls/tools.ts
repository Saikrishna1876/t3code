import {
  clampedPositiveInt,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewListResult,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PreviewManager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
};
const PreviewListTool = Tool.make("t3_preview_list", {
  ...shared,
  description:
    "List thread tabs. Automate runtime='server' only; others local desktop. Never pass their tabId to preview_*.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(clampedPositiveInt(50)),
  }),
  success: Schema.Struct({
    ...PreviewListResult.fields,
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const PreviewCloseTool = Tool.make("t3_preview_close", {
  ...shared,
  description: "Close owned tab. Close tabs opened for your check when done.",
  parameters: Schema.Struct({ tabId: PreviewTabId }),
  success: Schema.Struct({}),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
export const PreviewControlsToolkit = Toolkit.make(PreviewListTool, PreviewCloseTool);
