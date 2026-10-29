import { useAtomValue } from "@effect/atom-react";
import { useId, useState } from "react";
import type {
  CodespacesConfiguration,
  CodespacesOptions,
  CodespacesRunInput,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  codespaceStateLabel,
  codespacesOperationPresentation,
} from "@t3tools/client-runtime/codespaces-presentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentPresentation } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { codespacesEnvironment } from "~/state/codespaces";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ensureLocalApi } from "~/localApi";
import { randomUUID } from "~/lib/utils";
import { SettingsSection } from "./settingsLayout";
import { CodespacesLogHelp, ProjectCodespacesControl } from "../ProjectCodespacesControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function CodespacesSettings({
  environments,
}: {
  environments: readonly EnvironmentPresentation[];
}) {
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.codespaces,
  );
  if (!supported.length) return null;
  return (
    <SettingsSection id="connections-codespaces" title="Codespaces">
      {supported.map((environment) => (
        <CodespacesComputerSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </SettingsSection>
  );
}

function CodespacesComputerSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const inventory = useEnvironmentQuery(codespacesEnvironment.list({ environmentId, input: {} }));
  const state = useEnvironmentQuery(
    codespacesEnvironment.state({ environmentId, input: undefined }),
  );
  const canManage = useAtomValue(codespacesEnvironment.run.permissionAtom(environmentId));
  const run = useAtomCommand(codespacesEnvironment.run, { reportFailure: false });
  const authorize = useAtomCommand(codespacesEnvironment.authorize, { reportFailure: false });
  const loadOptions = useAtomCommand(codespacesEnvironment.options, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [options, setOptions] = useState<CodespacesOptions | null>(null);
  const [machine, setMachine] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CodespacesRunInput | null>(null);
  const formId = useId();
  const operation = state.data?.operations.at(-1);
  const feedback = operation ? codespacesOperationPresentation(operation) : null;
  const busy = pending || state.data?.operations.some((entry) => entry.status === "running");
  const authorization = state.data?.authorization;
  const authorizing = authorization?.phase === "starting" || authorization?.phase === "waiting";
  const refresh = () => {
    inventory.refresh();
    state.refresh();
  };
  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : "Codespace request failed.");
  };
  const execute = async (input: CodespacesRunInput) => {
    setPending(true);
    setError(null);
    setConfirmation(null);
    const result = await run({ environmentId, input });
    if (result._tag === "Failure") failure(result);
    else if (input.action === "create") setOptions(null);
    setPending(false);
    refresh();
  };
  const setup = async () => {
    setPending(true);
    setError(null);
    const result = await loadOptions({ environmentId, input: {} });
    if (result._tag === "Failure") failure(result);
    else {
      setOptions(result.value);
      setMachine(result.value.machines[0]?.name ?? "");
    }
    setPending(false);
  };
  return (
    <div className="space-y-4 px-3 py-4 sm:px-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">
          Codespaces are cloud computers. Create one from a blank template, then add projects in
          separate /workspaces folders.
        </p>
      </div>
      {error || inventory.error || state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? inventory.error ?? state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !canManage}
          onClick={async () => {
            setPending(true);
            setError(null);
            const result = await authorize({
              environmentId,
              input: { cancel: Boolean(authorizing) },
            });
            if (result._tag === "Failure") failure(result);
            setPending(false);
            refresh();
          }}
        >
          {authorizing ? "Cancel GitHub sign-in" : "Sign in for Codespaces access"}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={refresh}>
          Refresh status
        </Button>
        <Button size="sm" disabled={busy || !canManage} onClick={() => void setup()}>
          New Codespace
        </Button>
      </div>
      {authorization?.code ? (
        <div className="space-y-2">
          <p className="text-sm">
            GitHub code: <code className="select-all">{authorization.code}</code>
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void ensureLocalApi()
                .shell.openExternal("https://github.com/login/device")
                .catch(() =>
                  setError("Open https://github.com/login/device and enter the code above."),
                )
            }
          >
            Open GitHub
          </Button>
        </div>
      ) : null}
      {authorization?.message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {authorization.message}
        </p>
      ) : null}
      {options ? (
        <div className="space-y-3">
          <label className="grid gap-1.5 text-sm">
            Computer name
            <Input value={displayName} onValueChange={setDisplayName} placeholder="Optional name" />
          </label>
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={formId + "-machine"}>Machine</label>
            <Select
              value={machine}
              onValueChange={(value) => setMachine(value ?? "")}
              items={options.machines.map((entry) => ({
                value: entry.name,
                label: entry.displayName,
              }))}
            >
              <SelectTrigger id={formId + "-machine"}>
                <SelectValue placeholder="No machines available" />
              </SelectTrigger>
              <SelectPopup>
                {options.machines.map((entry) => (
                  <SelectItem key={entry.name} value={entry.name}>
                    {entry.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            Stops after 30 idle minutes. Files are retained for one day after stopping. GitHub
            compute and storage charges may apply.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !machine || !canManage}
              onClick={() =>
                setConfirmation({
                  action: "create",
                  clientRequestId: randomUUID(),
                  machine,
                  ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                  idleTimeoutMinutes: 30,
                  retentionDays: 1,
                })
              }
            >
              Create blank computer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOptions(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {inventory.data?.codespaces.map((space) => {
        const managed = state.data?.environments.find((entry) => entry.name === space.name);
        return (
          <div key={space.name} className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{space.displayName || space.name}</p>
                <p className="text-xs text-muted-foreground">
                  {codespaceStateLabel(space.state)}
                  {managed?.connected ? " · Connected" : ""} · {space.machine}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canManage}
                  onClick={() =>
                    void execute({
                      action: space.state === "Shutdown" ? "start" : "connect",
                      name: space.name,
                      clientRequestId: randomUUID(),
                    })
                  }
                >
                  {space.state === "Shutdown" ? "Start" : managed ? "Reconnect" : "Add computer"}
                </Button>
                {space.state === "Available" && managed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !canManage}
                    onClick={() =>
                      void execute({
                        action: "stop",
                        name: space.name,
                        clientRequestId: randomUUID(),
                      })
                    }
                  >
                    Stop
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !canManage}
                  onClick={() =>
                    setConfirmation({
                      action: "delete",
                      name: space.name,
                      clientRequestId: randomUUID(),
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        );
      })}
      {!inventory.isPending && !inventory.error && !inventory.data?.codespaces.length ? (
        <p className="text-sm text-muted-foreground">
          No Codespaces yet. Create a blank computer to get started.
        </p>
      ) : null}
      {feedback ? (
        <div role={feedback.tone === "error" ? "alert" : "status"} className="space-y-1 text-sm">
          <p>{feedback.label}</p>
          <p className="text-muted-foreground">{feedback.description}</p>
          <CodespacesLogHelp url={feedback.logHelpUrl} />
        </div>
      ) : null}
      {projects.length ? (
        <div className="space-y-3 border-t pt-4">
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={formId + "-project"}>Add or manage a project</label>
            <Select
              value={projectId}
              onValueChange={(value) => setProjectId(value as ProjectId | null)}
              items={projects.map((project) => ({ value: project.id, label: project.title }))}
            >
              <SelectTrigger id={formId + "-project"}>
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {projectId ? (
            <ProjectCodespacesControl
              key={projectId}
              environmentId={environmentId}
              projectId={projectId}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Add a project to this T3 host, then assign it to a computer here.
        </p>
      )}
      {state.data ? (
        <CodespacesAgentAccess
          environmentId={environmentId}
          configuration={state.data.configuration}
          disabled={Boolean(busy) || !canManage}
        />
      ) : null}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === "delete" ? "Delete computer?" : "Create blank computer?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "delete"
                ? "GitHub permanently deletes every project and unpushed change on this computer. Local thread history remains."
                : "GitHub compute and storage charges may apply. You can add several projects after creation."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm">
              {confirmation?.action === "create"
                ? "Template: github/codespaces-blank"
                : confirmation?.name}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmation?.action === "delete" ? "destructive" : "default"}
              disabled={busy || !canManage}
              onClick={() => {
                if (confirmation) void execute(confirmation);
              }}
            >
              {confirmation?.action === "delete" ? "Delete computer" : "Create computer"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function CodespacesAgentAccess({
  environmentId,
  configuration,
  disabled,
}: {
  environmentId: EnvironmentId;
  configuration: CodespacesConfiguration;
  disabled: boolean;
}) {
  const configure = useAtomCommand(codespacesEnvironment.configure, { reportFailure: false });
  const id = useId();
  const [optimisticValue, setOptimisticValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the acknowledged choice until the live subscription catches up.
  if (!saving && optimisticValue !== null && optimisticValue === configuration.agentAccessEnabled) {
    setOptimisticValue(null);
  }
  const update = async (enabled: boolean) => {
    setOptimisticValue(enabled);
    setSaving(true);
    setError(null);
    try {
      const result = await configure({
        environmentId,
        input: { ...configuration, agentAccessEnabled: enabled },
      });
      if (result._tag === "Failure") {
        setOptimisticValue(null);
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not update agent access.");
      } else {
        setOptimisticValue(result.value.configuration.agentAccessEnabled);
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <div aria-busy={saving}>
      <label className="flex items-start justify-between gap-3">
        <span>
          <span id={id + "-label"}>Allow agents to manage Codespaces</span>
          <span id={id + "-description"} className="mt-1 block text-xs text-muted-foreground">
            Applies to all projects on this T3 host. Full-access agents can create billable
            workspaces and delete remote files.
          </span>
        </span>
        <Switch
          checked={optimisticValue ?? configuration.agentAccessEnabled}
          disabled={disabled || saving}
          aria-labelledby={id + "-label"}
          aria-describedby={id + "-description " + id + "-status"}
          onCheckedChange={(enabled) => void update(enabled)}
        />
      </label>
      <p
        id={id + "-status"}
        role="status"
        className={"min-h-5 pt-1 text-xs " + (error ? "text-destructive" : "text-muted-foreground")}
      >
        {saving ? "Saving…" : error}
      </p>
    </div>
  );
}
