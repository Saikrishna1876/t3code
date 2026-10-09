import { useEffect, useId, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  CodespacesOptions,
  CodespacesRunInput,
} from "@t3tools/contracts";
import { GitBranch, Check, Cloud } from "lucide-react";
import {
  codespacesActionLabels,
  codespacesOperationPresentation,
  codespaceStateLabel,
} from "@t3tools/client-runtime/codespaces-presentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { codespacesEnvironment } from "~/state/codespaces";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPanel,
} from "./ui/dialog";

export function ProjectCodespacesControl(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  compact?: boolean;
}) {
  const environment = useEnvironment(props.environmentId);
  return environment?.serverConfig?.environment.capabilities.codespaces ? (
    <ProjectCodespacesControlPanel {...props} />
  ) : null;
}

function ProjectCodespacesControlPanel({
  environmentId,
  projectId,
  compact = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(!compact);
  const project = useEnvironmentQuery(
    codespacesEnvironment.project({ environmentId, input: { projectId } }),
  );
  const state = useEnvironmentQuery(
    expanded ? codespacesEnvironment.state({ environmentId, input: undefined }) : null,
  );
  const inventory = useEnvironmentQuery(
    expanded ? codespacesEnvironment.list({ environmentId, input: undefined }) : null,
  );
  const configure = useAtomCommand(codespacesEnvironment.configure, { reportFailure: false });
  const run = useAtomCommand(codespacesEnvironment.run, { reportFailure: false });
  const bind = useAtomCommand(codespacesEnvironment.bind, { reportFailure: false });
  const loadOptions = useAtomCommand(codespacesEnvironment.options, { reportFailure: false });
  const formId = useId();
  const [showSetup, setShowSetup] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [options, setOptions] = useState<CodespacesOptions | null>(null);
  const [machine, setMachine] = useState("");
  const [container, setContainer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CodespacesRunInput | null>(null);
  const info = project.data;
  const recent = state.data?.operations.findLast((operation) => operation.projectId === projectId);
  const busy = pending || recent?.status === "running";
  const feedback = recent ? codespacesOperationPresentation(recent) : null;
  const progressLabel = pending
    ? pendingLabel
    : recent?.status === "running"
      ? feedback?.label
      : null;
  const spaces =
    inventory.data?.codespaces.filter(
      (space) =>
        space.repository.toLowerCase() === info?.repository.toLowerCase() &&
        space.branch === info?.ref,
    ) ?? [];
  const bound = inventory.data?.codespaces.find((space) => space.name === info?.name);
  const containers =
    options?.devcontainers.filter((entry) => info?.devcontainerPaths.includes(entry.path)) ?? [];
  const workspaceLabel =
    progressLabel ?? (info?.connected ? "Connected" : codespaceStateLabel(bound?.state));
  const refresh = () => {
    setError(null);
    project.refresh();
    inventory.refresh();
    state.refresh();
  };
  const refreshProject = project.refresh;
  const refreshInventory = inventory.refresh;
  useEffect(() => {
    if (recent?.clientRequestId && recent.status !== "running") {
      refreshProject();
      refreshInventory();
    }
  }, [recent?.clientRequestId, recent?.status, refreshProject, refreshInventory]);
  const execute = async (input: CodespacesRunInput) => {
    setPendingLabel(codespacesActionLabels[input.action]);
    setPending(true);
    setError(null);
    setConfirmation(null);
    try {
      const result = await run({ environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Codespace request failed.");
      } else if (input.action === "create") {
        setShowSetup(false);
      }
      project.refresh();
      inventory.refresh();
    } finally {
      setPending(false);
    }
  };
  const selectLocal = async () => {
    setPendingLabel("Switching to local workspace");
    setPending(true);
    setError(null);
    try {
      const result = await bind({ environmentId, input: { projectId, name: null } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not switch to local work.");
      }
      project.refresh();
    } finally {
      setPending(false);
    }
  };
  const setup = async () => {
    if (!info) return;
    setPendingLabel("Loading configuration");
    setPending(true);
    setError(null);
    try {
      const result = await loadOptions({
        environmentId,
        input: { repository: info.repository, ref: info.ref },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not load Codespace options.");
        return;
      }
      setOptions(result.value);
      setShowSetup(true);
      setMachine((current) =>
        result.value.machines.some((entry) => entry.name === current)
          ? current
          : (result.value.machines[0]?.name ?? ""),
      );
      setContainer((current) =>
        result.value.devcontainers.some(
          (entry) => entry.path === current && info.devcontainerPaths.includes(entry.path),
        )
          ? current
          : (result.value.devcontainers.find((entry) => info.devcontainerPaths.includes(entry.path))
              ?.path ?? ""),
      );
    } finally {
      setPending(false);
    }
  };
  const lifecycle = (action: "start" | "connect" | "stop" | "delete", name: string) => {
    const input = {
      action,
      name,
      projectId,
      clientRequestId: randomUUID(),
    } satisfies CodespacesRunInput;
    if (action === "delete") setConfirmation(input);
    else void execute(input);
  };
  if (compact && info && !info.eligible && !info.name) return null;
  const content = (
    <div className="space-y-5">
      {info ? (
        <div className="space-y-1">
          <p className="break-words text-sm font-medium">{info.repository || "This project"}</p>
          {info.ref ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="break-all">{info.ref}</span>
            </p>
          ) : null}
        </div>
      ) : !project.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking project…
        </p>
      ) : null}
      {error || project.error || inventory.error || state.error ? (
        <Alert variant="error">
          <AlertTitle>Could not complete the request</AlertTitle>
          <AlertDescription>
            <p className="break-words">
              {error ?? project.error ?? inventory.error ?? state.error}
            </p>
            <p>Refresh status before trying again.</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {pending || feedback ? (
        <div
          role={feedback?.tone === "error" && !pending ? "alert" : "status"}
          className="space-y-1 text-sm"
        >
          <p
            className={
              feedback?.tone === "error" && !pending
                ? "font-medium text-destructive"
                : "flex items-center gap-1.5 font-medium"
            }
          >
            {!pending && feedback?.tone === "success" ? (
              <Check className="size-4 shrink-0" aria-hidden="true" />
            ) : null}
            {pending ? pendingLabel : feedback?.label}
          </p>
          {!pending && feedback?.description ? (
            <p className="break-words text-muted-foreground">{feedback.description}</p>
          ) : null}
          {busy ? (
            <p className="text-xs text-muted-foreground">
              You can close this panel. Work continues on your T3 host.
            </p>
          ) : null}
        </div>
      ) : null}
      {info ? (
        <>
          {!info.eligible ? <p className="text-sm text-muted-foreground">{info.reason}</p> : null}
          {info.name ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="break-words text-sm font-medium">
                    {bound?.displayName || info.name}
                  </p>
                  {bound?.displayName && bound.displayName !== info.name ? (
                    <p className="break-all text-xs text-muted-foreground">{info.name}</p>
                  ) : null}
                </div>
                <Badge variant={info.connected && !busy ? "success" : "secondary"}>
                  {workspaceLabel}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {!info.connected ? (
                  <Button
                    size="sm"
                    disabled={busy || !info.eligible || !bound}
                    onClick={() =>
                      lifecycle(bound?.state === "Shutdown" ? "start" : "connect", info.name!)
                    }
                  >
                    {bound?.state === "Shutdown" ? "Resume Codespace" : "Connect Codespace"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => lifecycle("stop", info.name!)}
                  >
                    Stop Codespace
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void selectLocal()}
                >
                  Work locally
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {bound?.state === "Shutdown"
                  ? "Resume to keep working with your existing files. Storage usage continues while stopped."
                  : "Stopping ends compute usage and keeps your remote files."}
              </p>
              {!bound && !inventory.isPending ? (
                <p className="text-xs text-muted-foreground">
                  Workspace unavailable in GitHub's inventory. Refresh status or switch to local
                  work.
                </p>
              ) : null}
            </div>
          ) : !showSetup || spaces.length ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {spaces.length ? "Reuse a Codespace" : "Work in a Codespace"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {spaces.length
                    ? "Keep your files and skip container creation."
                    : "Run files and commands remotely. Your agent, login and thread history stay on your T3 host."}
                </p>
              </div>
              {inventory.isPending && !inventory.data ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Looking for existing Codespaces…
                </p>
              ) : null}
              {spaces.map((space) => (
                <div key={space.name} className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">
                      {space.displayName || space.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {codespaceStateLabel(space.state)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={busy || !info.eligible}
                    onClick={() =>
                      lifecycle(space.state === "Shutdown" ? "start" : "connect", space.name)
                    }
                  >
                    {space.state === "Shutdown" ? "Resume" : "Use Codespace"}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {showSetup && options ? (
            <div className="space-y-4 border-t pt-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">New Codespace</h3>
                <p className="text-xs text-muted-foreground">
                  GitHub builds the container from this branch. Creation can take a few minutes.
                </p>
              </div>
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
                  <SelectTrigger
                    id={formId + "-machine"}
                    disabled={busy || !options.machines.length}
                  >
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
                {!options.machines.length ? (
                  <p className="text-xs text-muted-foreground">
                    No machines available for this repository. Check GitHub access, then refresh
                    configuration.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5 text-sm">
                <label htmlFor={formId + "-container"}>Dev-container configuration</label>
                <Select
                  value={container}
                  onValueChange={(value) => setContainer(value ?? "")}
                  items={containers.map((entry) => ({ value: entry.path, label: entry.name }))}
                >
                  <SelectTrigger
                    id={formId + "-container"}
                    disabled={busy || !containers.length}
                    aria-describedby={
                      !containers.length ? formId + "-configuration-help" : undefined
                    }
                  >
                    <SelectValue placeholder="Configuration not on GitHub yet" />
                  </SelectTrigger>
                  <SelectPopup>
                    {containers.map((entry) => (
                      <SelectItem key={entry.path} value={entry.path}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {!containers.length ? (
                  <p id={formId + "-configuration-help"} className="text-xs text-muted-foreground">
                    Push this project's .devcontainer configuration to {info.ref}, then refresh
                    configuration.
                  </p>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Stops after 30 idle minutes. GitHub retains files for one day after stopping.
                Compute and storage charges may apply.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || !machine || !container || !info.eligible}
                  onClick={() =>
                    setConfirmation({
                      action: "create",
                      clientRequestId: randomUUID(),
                      projectId,
                      repository: info.repository,
                      ref: info.ref,
                      machine,
                      devcontainerPath: container,
                      idleTimeoutMinutes: 30,
                      retentionDays: 1,
                    })
                  }
                >
                  Create Codespace
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setShowSetup(false)}
                >
                  Cancel
                </Button>
                {!containers.length || !options.machines.length ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void setup()}>
                    Refresh configuration
                  </Button>
                ) : null}
              </div>
            </div>
          ) : !info.name ? (
            <div className="space-y-2">
              <Button
                size="sm"
                variant={spaces.length ? "outline" : "default"}
                disabled={busy || !info.eligible || (inventory.isPending && !inventory.data)}
                onClick={() => (options ? setShowSetup(true) : void setup())}
              >
                <Cloud aria-hidden="true" />
                New Codespace
              </Button>
              <p className="text-xs text-muted-foreground">
                GitHub compute and storage charges may apply.
              </p>
            </div>
          ) : null}
          {info.name ? (
            <details className="border-t pt-3 text-sm">
              <summary className="min-h-11 cursor-pointer rounded-sm py-1.5 text-muted-foreground outline-none sm:min-h-6 sm:py-0 focus-visible:ring-2 focus-visible:ring-ring">
                Workspace options
              </summary>
              <div className="space-y-3 pt-3">
                {!showSetup ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !info.eligible}
                    onClick={() => (options ? setShowSetup(true) : void setup())}
                  >
                    New Codespace
                  </Button>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Deletion permanently removes remote files, including unpushed changes.
                </p>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => lifecycle("delete", info.name!)}
                >
                  Delete Codespace
                </Button>
              </div>
            </details>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-3">
        <details className="min-w-0 flex-1 text-sm">
          <summary className="min-h-11 cursor-pointer rounded-sm py-1.5 text-muted-foreground outline-none sm:min-h-6 sm:py-0 focus-visible:ring-2 focus-visible:ring-ring">
            Requirements & agent access
          </summary>
          <div className="space-y-4 pt-3">
            <p className="text-xs text-muted-foreground">
              Requires Codex 0.160.1 or later and the main checkout. Existing project terminals
              close when switching workspaces. Provider login stays on your T3 host.
            </p>
            {state.data ? (
              <label className="flex items-start justify-between gap-3">
                <span>
                  Allow agents to manage Codespaces
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Applies to all projects on this T3 host. Full-access agents can create billable
                    workspaces and delete remote files.
                  </span>
                </span>
                <Switch
                  checked={state.data.configuration.agentAccessEnabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => {
                    setPendingLabel("Saving agent access");
                    setPending(true);
                    setError(null);
                    void configure({
                      environmentId,
                      input: { ...state.data!.configuration, agentAccessEnabled: enabled },
                    })
                      .then((result) => {
                        if (result._tag === "Failure") {
                          const cause = squashAtomCommandFailure(result);
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not update agent access.",
                          );
                        }
                      })
                      .finally(() => setPending(false));
                  }}
                />
              </label>
            ) : null}
          </div>
        </details>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || project.isPending || inventory.isPending}
          onClick={refresh}
        >
          {project.isPending || inventory.isPending ? "Refreshing…" : "Refresh status"}
        </Button>
      </div>
    </div>
  );
  return (
    <>
      {compact ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
            {info?.name && (progressLabel || info.connected || inventory.data)
              ? "Codespace · " +
                (progressLabel ??
                  (info.connected ? "Connected" : codespaceStateLabel(bound?.state)))
              : "Codespace"}
          </Button>
          <Dialog open={expanded} onOpenChange={setExpanded}>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Project Codespace</DialogTitle>
                <DialogDescription>Manage this project's remote workspace.</DialogDescription>
              </DialogHeader>
              <DialogPanel>{content}</DialogPanel>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        content
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === "delete"
                ? "Delete this Codespace?"
                : "Create a Codespace for this project?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "delete"
                ? "GitHub will permanently delete its files, including unpushed changes. Your local thread history remains."
                : "GitHub may charge for compute and storage. Your existing local provider login will be used; no provider sign-in is needed in the Codespace."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-1 text-sm">
              <p className="break-words font-medium">
                {confirmation?.action === "delete"
                  ? bound?.displayName || confirmation.name
                  : info?.repository}
              </p>
              <p className="break-all text-muted-foreground">
                {confirmation?.action === "delete"
                  ? confirmation.name
                  : `${info?.ref} · ${options?.machines.find((entry) => entry.name === machine)?.displayName ?? machine}`}
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmation?.action === "delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => {
                if (confirmation) void execute(confirmation);
              }}
            >
              {confirmation?.action === "delete" ? "Delete Codespace" : "Create Codespace"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
