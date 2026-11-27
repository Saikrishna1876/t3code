import {
  OrchestratorMcpEnvironmentTarget,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
  clampedPositiveInt,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin/snooze/settle/archive/mark unread. Default thread here. Snooze needs snoozedUntil. Settles at turn end unless failed or message queued.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QUEUE_READ_ACTIONS = ["list", "read"] as const;
const QueueTool = Tool.make("t3_queue", {
  ...commandTool,
  description:
    "Queue for threadId or here. list: order/cursor/limit; read: 16000 chars; edit keeps attachments; cancel; reorder before beforeRunId (null=end); promote_to_steer uses active targetRunId. Needs queued run.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...QUEUE_READ_ACTIONS,
      "edit",
      "cancel",
      "reorder",
      "promote_to_steer",
    ]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    queuedRunId: Schema.optional(RunId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    beforeRunId: Schema.optional(Schema.NullOr(RunId)),
    targetRunId: Schema.optional(RunId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(clampedPositiveInt(100)),
  }),
  success: Schema.Union([
    Schema.Struct({ items: Schema.Array(queueEntry), nextCursor: Schema.NullOr(NonNegativeInt) }),
    queueEntry,
    OrchestrationV2DispatchCommandResult,
  ]),
}).annotate(Tool.Destructive, true);

const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
      preview: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const PendingRequestTool = Tool.make("t3_pending_request", {
  ...commandTool,
  description:
    "User questions, default this thread. list ids; read by requestId; respond with answers. No permission approvals.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(RuntimeRequestId),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  success: Schema.Union([
    Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
    Schema.Struct({ requestId: RuntimeRequestId, questions: Schema.Array(question) }),
    OrchestrationV2DispatchCommandResult,
  ]),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const threadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Read/set thread provider/model/modes (default here). Set with modelSelection. Permissions stay. Values: orchestrator_capabilities.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
  dependencies: [...commandTool.dependencies, ProviderRegistry.ProviderRegistry],
}).annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Fork thread (default here) at sourcePoint (default latest stable run): same setup, no turn. merge_back to related targetThreadId in same project. status lists transfers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      transfers: Schema.Array(
        Schema.Struct({
          id: OrchestrationV2ContextTransfer.fields.id,
          sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
          targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
          status: OrchestrationV2ContextTransfer.fields.status,
        }),
      ),
    }),
  ]),
}).annotate(Tool.Destructive, true);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active thread title/branch/PR/project then messages. Skip subagents. Use projectId; default own project, all outside thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    currentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    matches: Schema.Array(
      Schema.Struct({
        threadId: OrchestrationThreadSearchMatch.fields.threadId,
        projectId: OrchestrationThreadSearchMatch.fields.projectId,
        title: Schema.String,
        link: Schema.optional(Schema.String),
        source: Schema.Literals(["title", "user", "assistant"]),
        snippet: Schema.optional(OrchestrationThreadSearchMatch.fields.snippet),
        messageCreatedAt: Schema.optional(OrchestrationThreadSearchMatch.fields.messageCreatedAt),
      }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Start scheduled task (full-access/default). Returns thread or null before completion.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    link: Schema.optional(Schema.String),
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    lastRunError: ScheduledTask.fields.lastRunError,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const SubmitOutputTool = Tool.make("t3_submit_output", {
  ...commandTool,
  description:
    "Submit requested result as json text matching given schema. On rejection, fix named mismatch and retry.",
  // Stored on the run, which every client of the thread holds.
  parameters: Schema.Struct({ json: Schema.String.check(Schema.isMaxLength(200000)) }),
  success: Schema.Struct({ runId: RunId }),
})
  // It writes only the caller's own run, so a read-only or plan-mode agent can still answer.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadConfigureTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
  SubmitOutputTool,
);
