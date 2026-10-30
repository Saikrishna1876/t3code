import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  CodespacesRunInput,
  CodespacesProject,
} from "@t3tools/contracts";
import {
  codespacesSetupPrompt,
  codespaceStateLabel,
  codespacesOperationPresentation,
} from "@t3tools/client-runtime/codespaces-presentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { codespacesEnvironment } from "~/state/codespaces";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironment } from "~/state/environments";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useComposerDraftStore } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";
import { MenuGroup, MenuGroupLabel, MenuItem } from "./ui/menu";

function useProjectCodespaces(environmentId: EnvironmentId, projectId: ProjectId) {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.codespaces === true;
  const canManage = useAtomValue(codespacesEnvironment.run.permissionAtom(environmentId));
  const project = useEnvironmentQuery(
    supported ? codespacesEnvironment.project({ environmentId, input: { projectId } }) : null,
  );
  const inventory = useEnvironmentQuery(
    supported ? codespacesEnvironment.list({ environmentId, input: {} }) : null,
  );
  const state = useEnvironmentQuery(
    supported ? codespacesEnvironment.state({ environmentId, input: undefined }) : null,
  );
  const run = useAtomCommand(codespacesEnvironment.run, { reportFailure: false });
  const bind = useAtomCommand(codespacesEnvironment.bind, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = state.data?.operations.findLast(
    (entry) =>
      entry.projectId === projectId || (project.data?.name && entry.name === project.data.name),
  );
  const feedback = operation ? codespacesOperationPresentation(operation) : null;
  const busy = pending || operation?.status === "running";
  const managed = new Set(state.data?.environments.map((entry) => entry.name));
  const spaces =
    inventory.data?.codespaces.filter(
      (entry) => managed.has(entry.name) || entry.name === project.data?.name,
    ) ?? [];
  const execute = async (
    input: CodespacesRunInput | { name: null; dismissSetupWarning?: boolean },
  ) => {
    setPending(true);
    setError(null);
    const result =
      "action" in input
        ? await run({ environmentId, input })
        : await bind({
            environmentId,
            input: { projectId, ...input },
          });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Codespace request failed.");
    }
    setPending(false);
    project.refresh();
    inventory.refresh();
  };
  const select = (name: string, stopped: boolean) =>
    void execute({
      action: stopped ? "start" : "connect",
      name,
      projectId,
      clientRequestId: randomUUID(),
    });
  const dismissWarning = async (dismissSetupWarning: boolean) => {
    setPending(true);
    const result = await bind({
      environmentId,
      input: { projectId, name: project.data?.name ?? null, dismissSetupWarning },
    });
    if (result._tag === "Failure") setError("Could not save setup notification preference.");
    setPending(false);
    project.refresh();
  };
  return {
    project,
    spaces,
    supported,
    canManage,
    busy,
    select,
    execute,
    dismissWarning,
    feedback,
    error: error ?? project.error ?? inventory.error ?? state.error,
  };
}

export function CodespacesMenuItems({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const model = useProjectCodespaces(environmentId, projectId);
  if (!model.supported || (!model.spaces.length && !model.error && !model.project.data?.name))
    return null;
  return (
    <MenuGroup>
      <MenuGroupLabel>Cloud computers</MenuGroupLabel>
      {model.spaces.map((space) => (
        <MenuItem
          key={space.name}
          closeOnClick={false}
          disabled={model.busy || !model.canManage}
          onClick={() => model.select(space.name, space.state === "Shutdown")}
        >
          <span className="min-w-0 truncate">
            {space.displayName || space.name}
            {model.project.data?.name === space.name ? " (selected)" : ""}
          </span>
          <span className="text-xs text-muted-foreground">
            {space.state === "Shutdown" ? "Start" : codespaceStateLabel(space.state)}
          </span>
        </MenuItem>
      ))}
      {model.project.data?.name ? (
        <MenuItem
          closeOnClick={false}
          disabled={model.busy || !model.canManage}
          onClick={() => void model.execute({ name: null })}
        >
          Work locally
        </MenuItem>
      ) : null}
      {model.error || model.feedback?.tone === "error" ? (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {model.error ?? model.feedback?.description}
        </p>
      ) : model.busy ? (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {model.feedback?.label ?? "Connecting project…"}
        </p>
      ) : null}
      {model.feedback?.logHelpUrl ? (
        <MenuItem
          render={<a href={model.feedback.logHelpUrl} target="_blank" rel="noreferrer noopener" />}
        >
          How to view creation logs
        </MenuItem>
      ) : null}
    </MenuGroup>
  );
}

export function ProjectCodespacesControl({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const model = useProjectCodespaces(environmentId, projectId);
  const info = model.project.data;
  if (!model.supported) return null;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Add computers in Settings, Environments, Codespaces. Several projects can share one
        computer. Your provider login and history stay on this T3 host.
      </p>
      {model.error ? (
        <p role="alert" className="text-sm text-destructive">
          {model.error}
        </p>
      ) : null}
      {!info?.eligible && info?.reason ? (
        <p className="text-sm text-muted-foreground">{info.reason}</p>
      ) : null}
      {info?.workspacePath ? (
        <p className="break-all text-xs text-muted-foreground">{info.workspacePath}</p>
      ) : null}
      {info?.setupWarning && !info.setupWarningDismissed ? (
        <div className="space-y-2" role="status">
          <p className="text-sm text-muted-foreground">{info.setupWarning}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy || !model.canManage}
            onClick={() => void model.dismissWarning(true)}
          >
            Don't warn again for this project
          </Button>
        </div>
      ) : info?.setupWarningDismissed ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={model.busy || !model.canManage}
          onClick={() => void model.dismissWarning(false)}
        >
          Show setup warnings
        </Button>
      ) : null}
      {model.spaces.map((space) => (
        <div key={space.name} className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium">
              {space.displayName || space.name}
              {info?.name === space.name ? " (selected)" : ""}
            </p>
            <p className="text-xs text-muted-foreground">{codespaceStateLabel(space.state)}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy || !model.canManage || (!info?.eligible && !info?.name)}
            onClick={() => model.select(space.name, space.state === "Shutdown")}
          >
            {space.state === "Shutdown"
              ? "Start"
              : info?.name === space.name && info.connected
                ? "Reconnect"
                : "Use computer"}
          </Button>
        </div>
      ))}
      {!model.spaces.length ? (
        <p className="text-sm text-muted-foreground">No computers added yet.</p>
      ) : null}
      {info?.name ? (
        <Button
          size="sm"
          variant="outline"
          disabled={model.busy || !model.canManage}
          onClick={() => void model.execute({ name: null })}
        >
          Work locally
        </Button>
      ) : null}
      {model.feedback ? (
        <div
          role={model.feedback.tone === "error" ? "alert" : "status"}
          className="space-y-1 text-sm"
        >
          <p>{model.feedback.label}</p>
          <p className="text-muted-foreground">{model.feedback.description}</p>
          <CodespacesLogHelp url={model.feedback.logHelpUrl} />
        </div>
      ) : null}
      <ProjectCloudSetupButton environmentId={environmentId} projectId={projectId} />
      <p className="text-xs text-muted-foreground">
        The first connection copies your current committed branch. Commit local changes before
        adding a project. Codex and Claude Code can run here; other providers require local work.
      </p>
    </div>
  );
}

export function CodespacesLogHelp({ url }: { url: string | null }) {
  return url ? (
    <Button
      size="sm"
      variant="outline"
      render={<a href={url} target="_blank" rel="noreferrer noopener" />}
    >
      How to view creation logs
    </Button>
  ) : null;
}

function ProjectCloudSetupButton({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const openThread = useNewThreadHandler();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          const draft = await openThread(scopeProjectRef(environmentId, projectId)).catch(
            () => null,
          );
          if (draft) {
            const store = useComposerDraftStore.getState();
            store.setPrompt(
              draft.draftId,
              codespacesSetupPrompt(store.getComposerDraft(draft.draftId)?.prompt ?? ""),
            );
          } else
            setError("Could not open a setup draft. Open a new thread for this project and retry.");
          setPending(false);
        }}
      >
        Prepare cloud setup
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CodespacesSetupWarning({
  environmentId,
  project,
}: {
  environmentId: EnvironmentId;
  project: CodespacesProject;
}) {
  const bind = useAtomCommand(codespacesEnvironment.bind);
  const canManage = useAtomValue(codespacesEnvironment.bind.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  if (!project.setupWarning || project.setupWarningDismissed) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{project.setupWarning}</p>
      <Button
        size="xs"
        variant="outline"
        disabled={pending || !canManage}
        onClick={async () => {
          setPending(true);
          await bind({
            environmentId,
            input: { projectId: project.projectId, name: project.name, dismissSetupWarning: true },
          });
          setPending(false);
        }}
      >
        Don't warn again for this project
      </Button>
    </div>
  );
}
