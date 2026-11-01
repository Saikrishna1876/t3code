import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  CreateWorktreeProgress,
  ExecuteGitProgress,
  GitCommitProgress,
} from "../vcs/GitVcsDriver.ts";

export type WorkspaceGitProgress = CreateWorktreeProgress & ExecuteGitProgress & GitCommitProgress;

export function gitProgressOptionsIndex(method: string): number | null {
  return method === "execute"
    ? 0
    : method === "createWorktree"
      ? 1
      : method === "commit"
        ? 3
        : null;
}

export const WorkspaceGitProgressEvent = Schema.Union([
  Schema.Struct({ progress: Schema.Literal("onStdoutLine"), value: Schema.String }),
  Schema.Struct({ progress: Schema.Literal("onStderrLine"), value: Schema.String }),
  Schema.Struct({ progress: Schema.Literal("onHookStarted"), value: Schema.String }),
  Schema.Struct({
    progress: Schema.Literal("onHookFinished"),
    value: Schema.Struct({
      hookName: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      durationMs: Schema.NullOr(Schema.Number),
    }),
  }),
  Schema.Struct({
    progress: Schema.Literal("onOutputLine"),
    value: Schema.Struct({ stream: Schema.Literals(["stdout", "stderr"]), text: Schema.String }),
  }),
  Schema.Struct({ progress: Schema.Literal("onWorktreeClaimed"), value: Schema.String }),
  Schema.Struct({
    progress: Schema.Literal("onCheckoutProgress"),
    value: Schema.Struct({
      percent: Schema.Number,
      completed: Schema.Number,
      total: Schema.Number,
    }),
  }),
  Schema.Struct({ progress: Schema.Literal("onSubmodulesStarted") }),
  Schema.Struct({
    progress: Schema.Literal("onSubmodulesDisabled"),
    value: Schema.Struct({ source: Schema.Literals(["settings", "t3.json"]) }),
  }),
  Schema.Struct({ progress: Schema.Literal("onSubmoduleLine"), value: Schema.String }),
  Schema.Struct({
    progress: Schema.Literal("onSubmodulesFinished"),
    value: Schema.Struct({ ok: Schema.Boolean, detail: Schema.NullOr(Schema.String) }),
  }),
]);
export type WorkspaceGitProgressEvent = typeof WorkspaceGitProgressEvent.Type;

export function makeWorkspaceGitProgress(
  send: (event: WorkspaceGitProgressEvent) => Effect.Effect<void>,
): WorkspaceGitProgress {
  return {
    onStdoutLine: (value) => send({ progress: "onStdoutLine", value }),
    onStderrLine: (value) => send({ progress: "onStderrLine", value }),
    onHookStarted: (value) => send({ progress: "onHookStarted", value }),
    onHookFinished: (value) => send({ progress: "onHookFinished", value }),
    onOutputLine: (value) => send({ progress: "onOutputLine", value }),
    onWorktreeClaimed: (value) => send({ progress: "onWorktreeClaimed", value }),
    onCheckoutProgress: (value) => send({ progress: "onCheckoutProgress", value }),
    onSubmodulesStarted: () => send({ progress: "onSubmodulesStarted" }),
    onSubmodulesDisabled: (value) => send({ progress: "onSubmodulesDisabled", value }),
    onSubmoduleLine: (value) => send({ progress: "onSubmoduleLine", value }),
    onSubmodulesFinished: (value) => send({ progress: "onSubmodulesFinished", value }),
  };
}

export function applyWorkspaceGitProgress(
  progress: WorkspaceGitProgress,
  event: WorkspaceGitProgressEvent,
): Effect.Effect<void> {
  switch (event.progress) {
    case "onStdoutLine":
      return progress.onStdoutLine?.(event.value) ?? Effect.void;
    case "onStderrLine":
      return progress.onStderrLine?.(event.value) ?? Effect.void;
    case "onHookStarted":
      return progress.onHookStarted?.(event.value) ?? Effect.void;
    case "onHookFinished":
      return progress.onHookFinished?.(event.value) ?? Effect.void;
    case "onOutputLine":
      return progress.onOutputLine?.(event.value) ?? Effect.void;
    case "onWorktreeClaimed":
      return progress.onWorktreeClaimed?.(event.value) ?? Effect.void;
    case "onCheckoutProgress":
      return progress.onCheckoutProgress?.(event.value) ?? Effect.void;
    case "onSubmodulesStarted":
      return progress.onSubmodulesStarted?.() ?? Effect.void;
    case "onSubmodulesDisabled":
      return progress.onSubmodulesDisabled?.(event.value) ?? Effect.void;
    case "onSubmoduleLine":
      return progress.onSubmoduleLine?.(event.value) ?? Effect.void;
    case "onSubmodulesFinished":
      return progress.onSubmodulesFinished?.(event.value) ?? Effect.void;
  }
}
