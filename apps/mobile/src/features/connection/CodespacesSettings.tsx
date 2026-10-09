import { useEffect, useState } from "react";
import { Alert, Pressable, Switch, View } from "react-native";
import type {
  EnvironmentId,
  ProjectId,
  CodespacesRunInput,
  CodespacesOptions,
} from "@t3tools/contracts";
import {
  codespacesActionLabels,
  codespacesOperationPresentation,
  codespaceStateLabel,
} from "@t3tools/client-runtime/codespaces-presentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { useEnvironments } from "../../state/environments";
import { codespacesEnvironment } from "../../state/codespaces";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionSheetButton } from "./ConnectionSheetButton";

export function ProjectCodespacesControl(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const { environments } = useEnvironments();
  return environments.find((environment) => environment.environmentId === props.environmentId)
    ?.serverConfig?.environment.capabilities.codespaces ? (
    <ProjectCodespacesControlPanel {...props} />
  ) : null;
}

function ProjectCodespacesControlPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const project = useEnvironmentQuery(
    codespacesEnvironment.project({ environmentId, input: { projectId } }),
  );
  const inventory = useEnvironmentQuery(
    codespacesEnvironment.list({ environmentId, input: undefined }),
  );
  const state = useEnvironmentQuery(
    codespacesEnvironment.state({ environmentId, input: undefined }),
  );
  const configure = useAtomCommand(codespacesEnvironment.configure, { reportFailure: false });
  const run = useAtomCommand(codespacesEnvironment.run, { reportFailure: false });
  const bind = useAtomCommand(codespacesEnvironment.bind, { reportFailure: false });
  const loadOptions = useAtomCommand(codespacesEnvironment.options, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<CodespacesOptions | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showWorkspaceOptions, setShowWorkspaceOptions] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [machine, setMachine] = useState("");
  const [container, setContainer] = useState("");
  const info = project.data;
  const operation = state.data?.operations.findLast((item) => item.projectId === projectId);
  const feedback = operation ? codespacesOperationPresentation(operation) : null;
  const busy = pending || operation?.status === "running";
  const spaces =
    inventory.data?.codespaces.filter(
      (space) =>
        space.repository.toLowerCase() === info?.repository.toLowerCase() &&
        space.branch === info?.ref,
    ) ?? [];
  const bound = inventory.data?.codespaces.find((space) => space.name === info?.name);
  const containers =
    options?.devcontainers.filter((entry) => info?.devcontainerPaths.includes(entry.path)) ?? [];
  const workspaceLabel = pending
    ? pendingLabel
    : operation?.status === "running"
      ? feedback?.label
      : info?.connected
        ? "Connected"
        : codespaceStateLabel(bound?.state);
  const refreshProject = project.refresh;
  const refreshInventory = inventory.refresh;
  useEffect(() => {
    if (operation?.clientRequestId && operation.status !== "running") {
      refreshProject();
      refreshInventory();
    }
  }, [operation?.clientRequestId, operation?.status, refreshProject, refreshInventory]);
  const execute = async (input: CodespacesRunInput) => {
    setPendingLabel(codespacesActionLabels[input.action]);
    setPending(true);
    setError(null);
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
  const openSetup = () => (options ? setShowSetup(true) : void setup());
  const lifecycle = (action: "start" | "connect" | "stop" | "delete", name: string) =>
    void execute({ action, projectId, name, clientRequestId: uuidv4() });
  return (
    <SettingsSection title="Codespace">
      <View className="gap-5 p-4">
        {info ? (
          <View className="gap-1">
            <Text className="text-sm font-t3-medium text-foreground">
              {info.repository || "This project"}
            </Text>
            {info.ref ? (
              <Text className="text-xs text-foreground-muted">Branch: {info.ref}</Text>
            ) : null}
          </View>
        ) : !project.error ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            Checking project…
          </Text>
        ) : null}
        {error || project.error || inventory.error || state.error ? (
          <View className="gap-1">
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {error ?? project.error ?? inventory.error ?? state.error}
            </Text>
            <Text className="text-xs text-foreground-muted">
              Refresh status before trying again.
            </Text>
          </View>
        ) : null}
        {pending || feedback ? (
          <View className="gap-1">
            <Text
              accessibilityRole={feedback?.tone === "error" && !pending ? "alert" : undefined}
              accessibilityLiveRegion="polite"
              className={
                feedback?.tone === "error" && !pending
                  ? "text-sm font-t3-medium text-destructive"
                  : "text-sm font-t3-medium text-foreground"
              }
            >
              {pending ? pendingLabel : feedback?.label}
            </Text>
            {!pending && feedback?.description ? (
              <Text className="text-sm text-foreground-muted">{feedback.description}</Text>
            ) : null}
            {busy ? (
              <Text className="text-xs text-foreground-muted">
                You can leave this screen. Work continues on your T3 host.
              </Text>
            ) : null}
          </View>
        ) : null}
        {info ? (
          <>
            {!info.eligible ? (
              <Text className="text-sm text-foreground-muted">{info.reason}</Text>
            ) : null}
            {info.name ? (
              <View className="gap-3">
                <View className="gap-1">
                  <Text className="text-sm font-t3-medium text-foreground">
                    {bound?.displayName || info.name}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{workspaceLabel}</Text>
                </View>
                <ConnectionSheetButton
                  fullWidth
                  label={
                    info.connected
                      ? "Stop Codespace"
                      : bound?.state === "Shutdown"
                        ? "Resume Codespace"
                        : "Connect Codespace"
                  }
                  icon={info.connected ? "stop.fill" : "play"}
                  tone={info.connected ? "secondary" : "primary"}
                  disabled={busy || (!info.connected && (!info.eligible || !bound))}
                  onPress={() =>
                    lifecycle(
                      info.connected ? "stop" : bound?.state === "Shutdown" ? "start" : "connect",
                      info.name!,
                    )
                  }
                />
                <ConnectionSheetButton
                  fullWidth
                  label="Work locally"
                  icon="desktopcomputer"
                  disabled={busy}
                  onPress={() => {
                    setPendingLabel("Switching to local workspace");
                    setPending(true);
                    setError(null);
                    void bind({ environmentId, input: { projectId, name: null } })
                      .then((result) => {
                        if (result._tag === "Failure") {
                          const cause = squashAtomCommandFailure(result);
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not switch to local work.",
                          );
                        }
                        project.refresh();
                      })
                      .finally(() => setPending(false));
                  }}
                />
                <Text className="text-xs text-foreground-muted">
                  {bound?.state === "Shutdown"
                    ? "Resume to keep working with your existing files. Storage usage continues while stopped."
                    : "Stopping ends compute usage and keeps your remote files."}
                </Text>
                {!bound && !inventory.isPending ? (
                  <Text className="text-xs text-foreground-muted">
                    Workspace unavailable in GitHub's inventory. Refresh status or switch to local
                    work.
                  </Text>
                ) : null}
              </View>
            ) : !showSetup || spaces.length ? (
              <View className="gap-3">
                <View className="gap-1">
                  <Text className="text-sm font-t3-medium text-foreground">
                    {spaces.length ? "Reuse a Codespace" : "Work in a Codespace"}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {spaces.length
                      ? "Keep your files and skip container creation."
                      : "Run files and commands remotely. Your agent, login and thread history stay on your T3 host."}
                  </Text>
                </View>
                {inventory.isPending && !inventory.data ? (
                  <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                    Looking for existing Codespaces…
                  </Text>
                ) : null}
                {spaces.map((space) => (
                  <View key={space.name} className="gap-2">
                    <Text className="text-sm text-foreground">
                      {space.displayName || space.name}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {codespaceStateLabel(space.state)}
                    </Text>
                    <ConnectionSheetButton
                      fullWidth
                      label={space.state === "Shutdown" ? "Resume Codespace" : "Use Codespace"}
                      icon="play"
                      tone="primary"
                      disabled={busy || !info.eligible}
                      onPress={() =>
                        lifecycle(space.state === "Shutdown" ? "start" : "connect", space.name)
                      }
                    />
                  </View>
                ))}
              </View>
            ) : null}
            {showSetup && options ? (
              <View className="gap-4 border-t border-border-subtle pt-4">
                <View className="gap-1">
                  <Text className="text-sm font-t3-medium text-foreground">New Codespace</Text>
                  <Text className="text-xs text-foreground-muted">
                    GitHub builds the container from this branch. Creation can take a few minutes.
                  </Text>
                </View>
                <CodespaceOptionPicker
                  label="Machine"
                  value={machine}
                  placeholder="No machines available"
                  disabled={busy || !options.machines.length}
                  options={options.machines.map((entry) => ({
                    value: entry.name,
                    label: entry.displayName,
                  }))}
                  onSelect={setMachine}
                />
                {!options.machines.length ? (
                  <Text className="text-xs text-foreground-muted">
                    No machines available for this repository. Check GitHub access, then refresh
                    configuration.
                  </Text>
                ) : null}
                <CodespaceOptionPicker
                  label="Dev-container configuration"
                  value={container}
                  placeholder="Configuration not on GitHub yet"
                  disabled={busy || !containers.length}
                  options={containers.map((entry) => ({ value: entry.path, label: entry.name }))}
                  onSelect={setContainer}
                />
                {!containers.length ? (
                  <Text className="text-xs text-foreground-muted">
                    Push this project's .devcontainer configuration to {info.ref}, then refresh
                    configuration.
                  </Text>
                ) : null}
                <Text className="text-xs text-foreground-muted">
                  Stops after 30 idle minutes. GitHub retains files for one day after stopping.
                  Compute and storage charges may apply.
                </Text>
                <ConnectionSheetButton
                  fullWidth
                  label="Create Codespace"
                  icon="plus"
                  tone="primary"
                  disabled={busy || !machine || !container || !info.eligible}
                  onPress={() =>
                    Alert.alert(
                      "Create Codespace?",
                      `${info.repository} · ${info.ref}\nGitHub compute and storage charges may apply. Uses your existing local provider login.`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Create",
                          onPress: () =>
                            void execute({
                              action: "create",
                              projectId,
                              clientRequestId: uuidv4(),
                              repository: info.repository,
                              ref: info.ref,
                              machine,
                              devcontainerPath: container,
                              idleTimeoutMinutes: 30,
                              retentionDays: 1,
                            }),
                        },
                      ],
                    )
                  }
                />
                <ConnectionSheetButton
                  fullWidth
                  label="Cancel setup"
                  icon="xmark"
                  disabled={busy}
                  onPress={() => setShowSetup(false)}
                />
                {!containers.length || !options.machines.length ? (
                  <ConnectionSheetButton
                    fullWidth
                    label="Refresh configuration"
                    icon="arrow.clockwise"
                    disabled={busy}
                    onPress={() => void setup()}
                  />
                ) : null}
              </View>
            ) : !info.name ? (
              <View className="gap-2">
                <ConnectionSheetButton
                  fullWidth
                  label="New Codespace"
                  icon="plus"
                  tone={spaces.length ? "secondary" : "primary"}
                  disabled={busy || !info.eligible || (inventory.isPending && !inventory.data)}
                  onPress={openSetup}
                />
                <Text className="text-xs text-foreground-muted">
                  GitHub compute and storage charges may apply.
                </Text>
              </View>
            ) : null}
            {info.name ? (
              <View className="border-t border-border-subtle pt-2">
                <CodespaceDisclosure
                  label="Workspace options"
                  expanded={showWorkspaceOptions}
                  onPress={() => setShowWorkspaceOptions((value) => !value)}
                />
                {showWorkspaceOptions ? (
                  <View className="gap-3 pt-2">
                    <Text className="text-xs text-foreground-muted">{info.name}</Text>
                    {!showSetup ? (
                      <ConnectionSheetButton
                        fullWidth
                        label="New Codespace"
                        icon="plus"
                        disabled={busy || !info.eligible}
                        onPress={openSetup}
                      />
                    ) : null}
                    <Text className="text-xs text-foreground-muted">
                      Deletion permanently removes remote files, including unpushed changes.
                    </Text>
                    <ConnectionSheetButton
                      fullWidth
                      label="Delete Codespace"
                      icon="trash"
                      tone="danger"
                      disabled={busy}
                      onPress={() =>
                        Alert.alert(
                          "Delete Codespace?",
                          `${bound?.displayName || info.name}\nGitHub permanently deletes its files, including unpushed changes. Local thread history remains.`,
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Delete",
                              style: "destructive",
                              onPress: () => lifecycle("delete", info.name!),
                            },
                          ],
                        )
                      }
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
        <View className="gap-3 border-t border-border-subtle pt-2">
          <CodespaceDisclosure
            label="Requirements & agent access"
            expanded={showDetails}
            onPress={() => setShowDetails((value) => !value)}
          />
          {showDetails ? (
            <View className="gap-4">
              <Text className="text-xs text-foreground-muted">
                Requires Codex 0.160.1 or later and the main checkout. Existing project terminals
                close when switching workspaces. Provider login stays on your T3 host.
              </Text>
              {state.data ? (
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="text-sm text-foreground">
                      Allow agents to manage Codespaces
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      Applies to all projects on this T3 host. Full-access agents can create
                      billable workspaces and delete remote files.
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel="Allow agents to manage Codespaces on this T3 host"
                    value={state.data.configuration.agentAccessEnabled}
                    disabled={busy}
                    onValueChange={(enabled) => {
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
                </View>
              ) : null}
            </View>
          ) : null}
          <ConnectionSheetButton
            fullWidth
            label={project.isPending || inventory.isPending ? "Refreshing…" : "Refresh status"}
            icon="arrow.clockwise"
            disabled={pending || project.isPending || inventory.isPending}
            onPress={() => {
              setError(null);
              project.refresh();
              inventory.refresh();
              state.refresh();
            }}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function CodespaceDisclosure(props: { label: string; expanded: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center justify-between gap-3 py-2 active:opacity-70"
    >
      <Text className="flex-1 text-sm text-foreground-muted">{props.label}</Text>
      <SymbolView
        name={props.expanded ? "chevron.up" : "chevron.down"}
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

function CodespaceOptionPicker(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  onSelect: (value: string) => void;
}) {
  const value =
    props.options.find((entry) => entry.value === props.value)?.label ?? props.placeholder;
  const content = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${value}`}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      className="min-h-14 flex-row items-center gap-3 py-2 active:opacity-70 disabled:opacity-50"
    >
      <View className="flex-1 gap-1">
        <Text className="text-xs text-foreground-muted">{props.label}</Text>
        <Text className="text-sm text-foreground">{value}</Text>
      </View>
      <SymbolView
        name="chevron.down"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
  return props.disabled ? (
    content
  ) : (
    <ControlPillMenu
      title={props.label}
      actions={props.options.map((entry) => ({
        id: entry.value,
        title: entry.label,
        state: entry.value === props.value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      {content}
    </ControlPillMenu>
  );
}

export function CodespacesSettings() {
  return (
    <SettingsSection title="Codespaces">
      <Text className="p-4 text-sm text-foreground-muted">
        Open a project's overview to create or resume a Codespace. Add a .devcontainer configuration
        first. Agent, provider login and history stay on your T3 host.
      </Text>
    </SettingsSection>
  );
}
