import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Alert, Linking, Pressable, Switch, View } from "react-native";
import type {
  EnvironmentId,
  ProjectId,
  CodespacesRunInput,
  CodespacesProject,
  CodespacesOptions,
} from "@t3tools/contracts";
import {
  codespacesSetupPrompt,
  codespacesOperationPresentation,
  codespaceStateLabel,
} from "@t3tools/client-runtime/codespaces-presentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { codespacesEnvironment } from "../../state/codespaces";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { uuidv4 } from "../../lib/uuid";
import { SettingsSection } from "../settings/components/SettingsSection";
import { Button } from "../../components/ui/Button";

export function ProjectCodespacesControl({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const selectDetail = useSelectWorkspaceDetail();
  const [preparing, setPreparing] = useState(false);
  const supported = environments.find((entry) => entry.environmentId === environmentId)
    ?.serverConfig?.environment.capabilities.codespaces;
  return supported ? (
    <SettingsSection title="Cloud computer">
      <CodespacesPickerRows environmentId={environmentId} projectId={projectId} />
      <View className="px-4 pb-4">
        <Button
          fullWidth
          label="Prepare cloud setup"
          disabled={preparing}
          onPress={() => {
            setPreparing(true);
            void waitForComposerDraftsLoaded()
              .then(() => {
                const draftId = createNewTaskDraft({ environmentId, projectId });
                setComposerDraftText(
                  draftId,
                  codespacesSetupPrompt(getComposerDraftSnapshot(draftId).text),
                );
                selectDetail({
                  name: "Thread",
                  params: {
                    draft: {
                      environmentId,
                      projectId,
                      draftId,
                      title:
                        projects.find(
                          (entry) =>
                            entry.id === projectId && entry.environmentId === environmentId,
                        )?.title ?? "Cloud setup",
                    },
                  },
                });
              })
              .catch(() =>
                Alert.alert(
                  "Could not open setup draft",
                  "Open a new thread for this project and retry.",
                ),
              )
              .finally(() => setPreparing(false));
          }}
        />
      </View>
    </SettingsSection>
  ) : null;
}

export function CodespacesPickerRows({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const canManage = useAtomValue(codespacesEnvironment.run.permissionAtom(environmentId));
  const project = useEnvironmentQuery(
    codespacesEnvironment.project({ environmentId, input: { projectId } }),
  );
  const inventory = useEnvironmentQuery(codespacesEnvironment.list({ environmentId, input: {} }));
  const state = useEnvironmentQuery(
    codespacesEnvironment.state({ environmentId, input: undefined }),
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
  const info = project.data;
  const save = async (name: string | null, dismissSetupWarning?: boolean) => {
    setPending(true);
    setError(null);
    const result = await bind({
      environmentId,
      input: {
        projectId,
        name,
        ...(dismissSetupWarning !== undefined ? { dismissSetupWarning } : {}),
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not update project.");
    }
    setPending(false);
    project.refresh();
  };
  const select = async (name: string, stopped: boolean) => {
    setPending(true);
    setError(null);
    const result = await run({
      environmentId,
      input: { action: stopped ? "start" : "connect", projectId, name, clientRequestId: uuidv4() },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not connect project.");
    }
    setPending(false);
    project.refresh();
    inventory.refresh();
  };
  return (
    <View className="gap-3 p-4">
      <Text className="text-sm text-foreground-muted">
        Add computers in Settings, Environments, Codespaces. Projects share a computer in separate
        /workspaces folders.
      </Text>
      {error || project.error || inventory.error || state.error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error ?? project.error ?? inventory.error ?? state.error}
        </Text>
      ) : null}
      {info?.reason ? <Text className="text-sm text-foreground-muted">{info.reason}</Text> : null}
      {info?.workspacePath ? (
        <Text selectable className="text-xs text-foreground-muted">
          {info.workspacePath}
        </Text>
      ) : null}
      {info?.setupWarning && !info.setupWarningDismissed ? (
        <View className="gap-2">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {info.setupWarning}
          </Text>
          <Button
            label="Don't warn again for this project"
            disabled={busy || !canManage}
            onPress={() => void save(info.name, true)}
          />
        </View>
      ) : info?.setupWarningDismissed ? (
        <Button
          label="Show setup warnings"
          disabled={busy || !canManage}
          onPress={() => void save(info.name, false)}
        />
      ) : null}
      {spaces.map((space) => (
        <View key={space.name} className="flex-row items-center gap-3">
          <View className="flex-1 gap-1">
            <Text className="text-sm text-foreground">
              {space.displayName || space.name}
              {space.name === info?.name ? " (selected)" : ""}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {codespaceStateLabel(space.state)}
            </Text>
          </View>
          <Button
            label={space.state === "Shutdown" ? "Start" : "Use computer"}
            disabled={busy || !canManage || (!info?.eligible && !info?.name)}
            onPress={() => void select(space.name, space.state === "Shutdown")}
          />
        </View>
      ))}
      {!spaces.length ? (
        <Text className="text-sm text-foreground-muted">No computers added yet.</Text>
      ) : null}
      {info?.name ? (
        <Button
          fullWidth
          label="Work locally"
          disabled={busy || !canManage}
          onPress={() => void save(null)}
        />
      ) : null}
      {feedback ? (
        <View className="gap-1">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {feedback.label}
          </Text>
          <Text className="text-xs text-foreground-muted">{feedback.description}</Text>
          <CodespacesLogHelp url={feedback.logHelpUrl} />
        </View>
      ) : null}
      <Button
        fullWidth
        label="Refresh status"
        disabled={pending}
        onPress={() => {
          project.refresh();
          inventory.refresh();
          state.refresh();
        }}
      />
      <Text className="text-xs text-foreground-muted">
        First connection copies your current committed branch. Commit local changes first. Codex and
        Claude Code run here; other providers require local work.
      </Text>
    </View>
  );
}

export function CodespacesSettings() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments
        .filter((environment) => environment.serverConfig?.environment.capabilities.codespaces)
        .map((environment) => (
          <ComputerSettings
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
    </>
  );
}

function ComputerSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const canManage = useAtomValue(codespacesEnvironment.run.permissionAtom(environmentId));
  const state = useEnvironmentQuery(
    codespacesEnvironment.state({ environmentId, input: undefined }),
  );
  const inventory = useEnvironmentQuery(codespacesEnvironment.list({ environmentId, input: {} }));
  const run = useAtomCommand(codespacesEnvironment.run, { reportFailure: false });
  const authorize = useAtomCommand(codespacesEnvironment.authorize, { reportFailure: false });
  const configure = useAtomCommand(codespacesEnvironment.configure, { reportFailure: false });
  const loadOptions = useAtomCommand(codespacesEnvironment.options, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState("");
  const [options, setOptions] = useState<CodespacesOptions | null>(null);
  const [machine, setMachine] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy =
    pending || state.data?.operations.some((operation) => operation.status === "running");
  const operation = state.data?.operations.at(-1);
  const feedback = operation ? codespacesOperationPresentation(operation) : null;
  const authorizing =
    state.data?.authorization?.phase === "starting" ||
    state.data?.authorization?.phase === "waiting";
  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : "Codespace request failed.");
  };
  const execute = async (input: CodespacesRunInput) => {
    setPending(true);
    setError(null);
    const result = await run({ environmentId, input });
    if (result._tag === "Failure") failure(result);
    else if (input.action === "create") setOptions(null);
    setPending(false);
    state.refresh();
    inventory.refresh();
  };
  return (
    <SettingsSection title={`Codespaces · ${label}`}>
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          Create a blank cloud computer, then add several projects. Provider login and history stay
          on your T3 host.
        </Text>
        {error || state.error || inventory.error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error ?? state.error ?? inventory.error}
          </Text>
        ) : null}
        <Button
          fullWidth
          label={authorizing ? "Cancel GitHub sign-in" : "Sign in for Codespaces access"}
          disabled={pending || !canManage}
          onPress={async () => {
            setPending(true);
            setError(null);
            const result = await authorize({
              environmentId,
              input: { cancel: Boolean(authorizing) },
            });
            if (result._tag === "Failure") failure(result);
            setPending(false);
            state.refresh();
          }}
        />
        {state.data?.authorization?.code ? (
          <View className="gap-2">
            <Text selectable className="text-sm text-foreground">
              GitHub code: {state.data.authorization.code}
            </Text>
            <Button
              label="Open GitHub"
              onPress={() =>
                void Linking.openURL("https://github.com/login/device").catch(() =>
                  setError("Open https://github.com/login/device and enter the code above."),
                )
              }
            />
          </View>
        ) : null}
        {state.data?.authorization?.message ? (
          <Text className="text-xs text-foreground-muted">{state.data.authorization.message}</Text>
        ) : null}
        <Button
          fullWidth
          label="New Codespace"
          disabled={busy || !canManage}
          onPress={async () => {
            setPending(true);
            setError(null);
            const result = await loadOptions({ environmentId, input: {} });
            if (result._tag === "Failure") failure(result);
            else {
              setOptions(result.value);
              setMachine(result.value.machines[0]?.name ?? "");
            }
            setPending(false);
          }}
        />
        {options ? (
          <View className="gap-3">
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
            <Text className="text-xs text-foreground-muted">
              Stops after 30 idle minutes. Files are retained for one day after stopping. GitHub
              compute and storage charges may apply.
            </Text>
            <Button
              fullWidth
              label="Create blank computer"
              disabled={busy || !machine || !canManage}
              onPress={() =>
                Alert.alert(
                  "Create blank computer?",
                  "Uses github/codespaces-blank. GitHub compute and storage charges may apply.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Create",
                      onPress: () =>
                        void execute({
                          action: "create",
                          clientRequestId: uuidv4(),
                          machine,
                          idleTimeoutMinutes: 30,
                          retentionDays: 1,
                        }),
                    },
                  ],
                )
              }
            />
            <Button label="Cancel" onPress={() => setOptions(null)} />
          </View>
        ) : null}
        {inventory.data?.codespaces.map((space) => {
          const managed = state.data?.environments.find((entry) => entry.name === space.name);
          return (
            <View key={space.name} className="gap-2 border-t border-border-subtle pt-3">
              <Text className="text-sm font-t3-medium text-foreground">
                {space.displayName || space.name}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {codespaceStateLabel(space.state)} · {space.machine}
                {managed?.connected ? " · Connected" : ""}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={
                    space.state === "Shutdown" ? "Start" : managed ? "Reconnect" : "Add computer"
                  }
                  disabled={busy || !canManage}
                  onPress={() =>
                    void execute({
                      action: space.state === "Shutdown" ? "start" : "connect",
                      name: space.name,
                      clientRequestId: uuidv4(),
                    })
                  }
                />
                {space.state === "Available" && managed ? (
                  <Button
                    label="Stop"
                    disabled={busy || !canManage}
                    onPress={() =>
                      void execute({ action: "stop", name: space.name, clientRequestId: uuidv4() })
                    }
                  />
                ) : null}
                <Button
                  label="Delete"
                  tone="danger"
                  disabled={busy || !canManage}
                  onPress={() =>
                    Alert.alert(
                      "Delete computer?",
                      "GitHub permanently deletes every project and unpushed change on this computer. Local history remains.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () =>
                            void execute({
                              action: "delete",
                              name: space.name,
                              clientRequestId: uuidv4(),
                            }),
                        },
                      ],
                    )
                  }
                />
              </View>
            </View>
          );
        })}
        {feedback ? (
          <View className="gap-1">
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
              {feedback.label}
            </Text>
            <Text className="text-xs text-foreground-muted">{feedback.description}</Text>
            <CodespacesLogHelp url={feedback.logHelpUrl} />
          </View>
        ) : null}
        {projects.length ? (
          <CodespaceOptionPicker
            label="Add or manage a project"
            value={projectId}
            placeholder="Choose a project"
            disabled={!canManage}
            options={projects.map((project) => ({ value: project.id, label: project.title }))}
            onSelect={setProjectId}
          />
        ) : (
          <Text className="text-xs text-foreground-muted">
            Add a project to this T3 host, then assign it to a computer here.
          </Text>
        )}
        {projectId ? (
          <CodespacesPickerRows
            key={projectId}
            environmentId={environmentId}
            projectId={projectId as ProjectId}
          />
        ) : null}
        {state.data ? (
          <View className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-sm text-foreground">
              Allow agents to manage billable Codespaces
            </Text>
            <Switch
              accessibilityLabel="Allow agents to manage Codespaces"
              value={state.data.configuration.agentAccessEnabled}
              disabled={busy || !canManage}
              onValueChange={async (enabled) => {
                if (!state.data) return;
                setPending(true);
                setError(null);
                const result = await configure({
                  environmentId,
                  input: { ...state.data.configuration, agentAccessEnabled: enabled },
                });
                if (result._tag === "Failure") failure(result);
                setPending(false);
              }}
            />
          </View>
        ) : null}
        <Button
          fullWidth
          label="Refresh status"
          disabled={pending}
          onPress={() => {
            inventory.refresh();
            state.refresh();
          }}
        />
      </View>
    </SettingsSection>
  );
}

function CodespacesLogHelp({ url }: { url: string | null }) {
  return url ? (
    <Button
      label="How to view creation logs"
      tone="text"
      onPress={() =>
        void Linking.openURL(url).catch(() =>
          Alert.alert("Could not open log instructions", `Open ${url} in your browser.`),
        )
      }
    />
  ) : null;
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
    <Menu
      title={props.label}
      actions={props.options.map((entry) => ({
        id: entry.value,
        title: entry.label,
        state: entry.value === props.value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      {content}
    </Menu>
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
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">{project.setupWarning}</Text>
      <Button
        label="Don't warn again for this project"
        disabled={pending || !canManage}
        onPress={async () => {
          setPending(true);
          await bind({
            environmentId,
            input: { projectId: project.projectId, name: project.name, dismissSetupWarning: true },
          });
          setPending(false);
        }}
      />
    </View>
  );
}
