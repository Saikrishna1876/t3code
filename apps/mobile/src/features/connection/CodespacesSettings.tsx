import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { Alert, Linking, Pressable, Switch, View } from "react-native";
import type {
  Codespace,
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
  projectCodespaceNames,
} from "@t3tools/client-runtime/codespaces-presentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { codespacesEnvironment } from "../../state/codespaces";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { uuidv4 } from "../../lib/uuid";
import { m } from "../../i18n/messages";
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
  const gt = useGT();
  const supported = environments.find((entry) => entry.environmentId === environmentId)
    ?.serverConfig?.environment.capabilities.codespaces;
  return supported ? (
    <SettingsSection title={gt("Cloud computer")}>
      <CodespacesPickerRows environmentId={environmentId} projectId={projectId} />
      <View className="px-4 pb-4">
        <Button
          fullWidth
          label={gt("Prepare cloud setup")}
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
                        )?.title ?? gt("Cloud setup"),
                    },
                  },
                });
              })
              .catch(() =>
                Alert.alert(
                  m(msg("Could not open setup draft")),
                  m(msg("Open a new thread for this project and retry.")),
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
  codespaceName,
  onCodespaceChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  codespaceName?: string | null;
  onCodespaceChange?: (name: string | null) => void;
}) {
  const [inspectedName, setInspectedName] = useState<string | null>(null);
  const gt = useGT();
  const messages = useMessages();
  const name = codespaceName === undefined ? inspectedName : codespaceName;
  const canManage = useAtomValue(codespacesEnvironment.run.permissionAtom(environmentId));
  const project = useEnvironmentQuery(
    codespacesEnvironment.project({ environmentId, input: { projectId, name } }),
  );
  const inventory = useEnvironmentQuery(codespacesEnvironment.list({ environmentId, input: {} }));
  const state = useEnvironmentQuery(
    codespacesEnvironment.state({ environmentId, input: undefined }),
  );
  const run = useAtomCommand(codespacesEnvironment.run, { reportFailure: false });
  const bind = useAtomCommand(codespacesEnvironment.bind, { reportFailure: false });
  const loadOptions = useAtomCommand(codespacesEnvironment.options, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [machines, setMachines] = useState<CodespacesOptions["machines"] | null>(null);
  const [machine, setMachine] = useState("");
  const operation = state.data?.operations.findLast(
    (entry) =>
      entry.projectId === projectId || (project.data?.name && entry.name === project.data.name),
  );
  const feedback = operation ? codespacesOperationPresentation(operation, messages) : null;
  const busy = pending || operation?.status === "running";
  const available = projectCodespaceNames(state.data, projectId);
  const spaces =
    inventory.data?.codespaces.filter(
      (entry) => available.has(entry.name) || entry.name === name,
    ) ?? [];
  const info = project.data;
  const loadMachines = async () => {
    setPending(true);
    setError(null);
    const result = await loadOptions({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not load Codespace machines."));
      return;
    }
    setMachines(result.value.machines);
    setMachine(result.value.machines[0]?.name ?? "");
  };
  const create = async () => {
    setPending(true);
    setError(null);
    const result = await run({
      environmentId,
      input: {
        action: "create",
        projectId,
        machine,
        clientRequestId: uuidv4(),
        idleTimeoutMinutes: 30,
        retentionDays: 1,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Codespace request failed."));
      return;
    }
    setMachines(null);
    state.refresh();
    inventory.refresh();
  };
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
      setError(cause instanceof Error ? cause.message : gt("Could not update project."));
    }
    setPending(false);
    project.refresh();
  };
  const select = async (name: string, stopped: boolean) => {
    setInspectedName(name);
    onCodespaceChange?.(name);
    if (
      !stopped &&
      state.data?.environments.some((entry) => entry.name === name && entry.connected)
    ) {
      await save(name);
      return;
    }
    setPending(true);
    setError(null);
    const result = await run({
      environmentId,
      input: { action: stopped ? "start" : "connect", projectId, name, clientRequestId: uuidv4() },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not connect project."));
    }
    setPending(false);
    project.refresh();
    inventory.refresh();
  };
  return (
    <View className="gap-3 p-4">
      <Text className="text-sm text-foreground-muted">
        <T>
          Create a Codespace from Run on or add a computer in Settings, Environments, Codespaces.
        </T>
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
            label={gt("Don't warn again for this project")}
            disabled={busy || !canManage}
            onPress={() => void save(info.name, true)}
          />
        </View>
      ) : info?.setupWarningDismissed ? (
        <Button
          label={gt("Show setup warnings")}
          disabled={busy || !canManage}
          onPress={() => void save(info.name, false)}
        />
      ) : null}
      {spaces.map((space) => (
        <View key={space.name} className="flex-row items-center gap-3">
          <View className="flex-1 gap-1">
            <Text className="text-sm text-foreground">
              {space.name === info?.name
                ? gt("{name} (selected)", { name: space.displayName || space.name })
                : space.displayName || space.name}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {codespaceStateLabel(space.state, messages)}
            </Text>
          </View>
          <Button
            label={
              space.state === "Shutdown"
                ? gt("Start", { $context: "button, starts a stopped cloud computer" })
                : onCodespaceChange
                  ? gt("Select", { $context: "button, chooses a cloud computer" })
                  : gt("Prepare project")
            }
            disabled={busy || !canManage || (!info?.eligible && !info?.name)}
            onPress={() => void select(space.name, space.state === "Shutdown")}
          />
        </View>
      ))}
      {!spaces.length ? (
        <Text className="text-sm text-foreground-muted">
          <T>No computers added yet.</T>
        </Text>
      ) : null}
      {onCodespaceChange &&
        (machines === null ? (
          <Button
            fullWidth
            label={gt("New Codespace")}
            disabled={busy || !canManage || !info?.eligible}
            onPress={() => void loadMachines()}
          />
        ) : (
          <>
            <CodespaceOptionPicker
              label={gt("Machine", { $context: "cloud computer hardware type" })}
              value={machine}
              placeholder={gt("No machines available")}
              disabled={busy || !machines.length}
              options={machines.map((entry) => ({ value: entry.name, label: entry.displayName }))}
              onSelect={setMachine}
            />
            <Button
              fullWidth
              label={gt("Create Codespace")}
              disabled={busy || !canManage || !info?.eligible || !machine}
              onPress={() =>
                Alert.alert(
                  gt("Create Codespace"),
                  gt("GitHub compute and storage charges may apply."),
                  [
                    { text: gt("Cancel"), style: "cancel" },
                    { text: gt("Create"), onPress: () => void create() },
                  ],
                )
              }
            />
            <Button label={gt("Cancel")} onPress={() => setMachines(null)} />
          </>
        ))}
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
        label={gt("Refresh status")}
        disabled={pending}
        onPress={() => {
          project.refresh();
          inventory.refresh();
          state.refresh();
        }}
      />
      <Text className="text-xs text-foreground-muted">
        <T>
          First connection copies your current committed branch. Commit local changes first. Codex
          and Claude Code run here; other providers require local work.
        </T>
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
  const gt = useGT();
  const messages = useMessages();
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
  const [editing, setEditing] = useState<{
    space: Codespace;
    kind: "rename" | "resize";
    value: string;
    options: CodespacesOptions | null;
  } | null>(null);
  const [options, setOptions] = useState<CodespacesOptions | null>(null);
  const [machine, setMachine] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy =
    pending || state.data?.operations.some((operation) => operation.status === "running");
  const operation = state.data?.operations.at(-1);
  const feedback = operation ? codespacesOperationPresentation(operation, messages) : null;
  const authorizing =
    state.data?.authorization?.phase === "starting" ||
    state.data?.authorization?.phase === "waiting";
  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : gt("Codespace request failed."));
  };
  const execute = async (input: CodespacesRunInput) => {
    setPending(true);
    setError(null);
    setEditing(null);
    const result = await run({ environmentId, input });
    if (result._tag === "Failure") failure(result);
    else if (input.action === "create") setOptions(null);
    setPending(false);
    state.refresh();
    inventory.refresh();
  };
  const editComputer = async (space: Codespace, kind: "rename" | "resize") => {
    if (!canManage || busy) return;
    if (kind === "rename") {
      setEditing({ space, kind, value: space.displayName || space.name, options: null });
      return;
    }
    if (space.state !== "Shutdown") return;
    setPending(true);
    setError(null);
    const result = await loadOptions({ environmentId, input: {} });
    if (result._tag === "Failure") failure(result);
    else setEditing({ space, kind, value: space.machine, options: result.value });
    setPending(false);
  };
  const canSaveEdit =
    editing !== null &&
    Boolean(editing.value.trim()) &&
    editing.value.trim() !==
      (editing.kind === "rename"
        ? editing.space.displayName || editing.space.name
        : editing.space.machine);
  return (
    <SettingsSection title={gt("Codespaces · {label}", { label })}>
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          <T>Create a blank Codespace here, then attach a project.</T>
        </Text>
        {error || state.error || inventory.error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error ?? state.error ?? inventory.error}
          </Text>
        ) : null}
        <Button
          fullWidth
          label={authorizing ? gt("Cancel GitHub sign-in") : gt("Sign in for Codespaces access")}
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
              <T>
                GitHub code: <Var>{state.data.authorization.code}</Var>
              </T>
            </Text>
            <Button
              label={gt("Open {product}", { product: "GitHub" })}
              onPress={() =>
                void Linking.openURL("https://github.com/login/device").catch(() =>
                  setError(
                    gt("Open {url} and enter the code above.", {
                      url: "https://github.com/login/device",
                    }),
                  ),
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
          label={gt("New Codespace")}
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
              label={gt("Machine", { $context: "cloud computer hardware type" })}
              value={machine}
              placeholder={gt("No machines available")}
              disabled={busy || !options.machines.length}
              options={options.machines.map((entry) => ({
                value: entry.name,
                label: entry.displayName,
              }))}
              onSelect={setMachine}
            />
            <Text className="text-xs text-foreground-muted">
              <T>
                Stops after 30 idle minutes. Files are retained for one day after stopping. GitHub
                compute and storage charges may apply.
              </T>
            </Text>
            <Button
              fullWidth
              label={gt("Create blank computer")}
              disabled={busy || !machine || !canManage}
              onPress={() =>
                Alert.alert(
                  m(msg("Create blank computer?")),
                  m(
                    msg("Uses {template}. GitHub compute and storage charges may apply.", {
                      template: "github/codespaces-blank",
                    }),
                  ),
                  [
                    { text: m(msg("Cancel")), style: "cancel" },
                    {
                      text: m(msg("Create")),
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
            <Button label={gt("Cancel")} onPress={() => setOptions(null)} />
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
                {managed?.connected
                  ? gt("{state} · {machine} · Connected", {
                      state: codespaceStateLabel(space.state, messages),
                      machine: space.machine,
                    })
                  : `${codespaceStateLabel(space.state, messages)} · ${space.machine}`}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={
                    space.state === "Shutdown"
                      ? gt("Start", { $context: "button, starts a stopped cloud computer" })
                      : managed
                        ? gt("Reconnect")
                        : gt("Add computer")
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
                    label={gt("Stop", { $context: "button, stops a running cloud computer" })}
                    disabled={busy || !canManage}
                    onPress={() =>
                      void execute({ action: "stop", name: space.name, clientRequestId: uuidv4() })
                    }
                  />
                ) : null}
                <Button
                  label={gt("Rename")}
                  disabled={busy || !canManage}
                  onPress={() => void editComputer(space, "rename")}
                />
                <Button
                  label={gt("Change machine")}
                  disabled={busy || !canManage || space.state !== "Shutdown"}
                  onPress={() => void editComputer(space, "resize")}
                />
                <Button
                  label={gt("Rebuild", { $context: "button, rebuilds a cloud computer" })}
                  disabled={busy || !canManage || (!managed && space.state !== "Shutdown")}
                  onPress={() =>
                    Alert.alert(
                      m(msg("Rebuild computer?")),
                      m(
                        msg(
                          "Finish or stop active turns first. Rebuilding affects every project on this computer and may reset installed tools. GitHub compute and storage charges may apply.",
                        ),
                      ),
                      [
                        { text: m(msg("Cancel")), style: "cancel" },
                        {
                          text: m(
                            msg("Rebuild", { $context: "button, rebuilds a cloud computer" }),
                          ),
                          onPress: () =>
                            void execute({
                              action: "rebuild",
                              name: space.name,
                              clientRequestId: uuidv4(),
                            }),
                        },
                      ],
                    )
                  }
                />
                <Button
                  label={gt("Delete")}
                  tone="danger"
                  disabled={busy || !canManage}
                  onPress={() =>
                    Alert.alert(
                      m(msg("Delete computer?")),
                      m(
                        msg(
                          "GitHub permanently deletes every project and unpushed change on this computer. Local history remains.",
                        ),
                      ),
                      [
                        { text: m(msg("Cancel")), style: "cancel" },
                        {
                          text: m(msg("Delete")),
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
              {editing?.space.name === space.name ? (
                <View className="gap-3">
                  <Text className="text-sm font-t3-medium text-foreground">
                    {editing.kind === "rename" ? gt("Rename computer") : gt("Change machine")}
                  </Text>
                  {editing.kind === "rename" ? (
                    <AppTextInput
                      accessibilityLabel={gt("Computer name")}
                      value={editing.value}
                      editable={!busy && canManage}
                      onChangeText={(value) => setEditing({ ...editing, value })}
                    />
                  ) : (
                    <CodespaceOptionPicker
                      label={gt("Machine", { $context: "cloud computer hardware type" })}
                      value={editing.value}
                      placeholder={gt("Choose a machine")}
                      disabled={busy || !canManage}
                      options={
                        editing.options?.machines.map((entry) => ({
                          value: entry.name,
                          label: entry.displayName,
                        })) ?? []
                      }
                      onSelect={(value) => setEditing({ ...editing, value })}
                    />
                  )}
                  <Text className="text-xs text-foreground-muted">
                    {editing.kind === "rename"
                      ? gt("Update the name shown for this computer across all projects.")
                      : gt(
                          "The computer must stay stopped while changing its machine. This affects every project on it. GitHub compute and storage charges may change.",
                        )}
                  </Text>
                  <View className="flex-row gap-2">
                    <Button
                      label={editing.kind === "rename" ? gt("Save name") : gt("Change machine")}
                      disabled={busy || !canManage || !canSaveEdit}
                      onPress={() => {
                        if (!canSaveEdit) return;
                        void execute({
                          action: "update",
                          name: editing.space.name,
                          clientRequestId: uuidv4(),
                          ...(editing.kind === "rename"
                            ? { displayName: editing.value.trim() }
                            : { machine: editing.value }),
                        });
                      }}
                    />
                    <Button label={gt("Cancel")} onPress={() => setEditing(null)} />
                  </View>
                </View>
              ) : null}
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
            label={gt("Add or manage a project")}
            value={projectId}
            placeholder={gt("Choose a project")}
            disabled={!canManage}
            options={projects.map((project) => ({ value: project.id, label: project.title }))}
            onSelect={setProjectId}
          />
        ) : (
          <Text className="text-xs text-foreground-muted">
            <T>Add a project to this T3 host, then assign it to a computer here.</T>
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
              <T>Allow agents to manage billable Codespaces</T>
            </Text>
            <Switch
              accessibilityLabel={gt("Allow agents to manage Codespaces")}
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
          label={gt("Refresh status")}
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
  const gt = useGT();
  return url ? (
    <Button
      label={gt("How to view creation logs")}
      tone="text"
      onPress={() =>
        void Linking.openURL(url).catch(() =>
          Alert.alert(
            m(msg("Could not open log instructions")),
            m(msg("Open {url} in your browser.", { url })),
          ),
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
  const gt = useGT();
  if (!project.setupWarning || project.setupWarningDismissed) return null;
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">{project.setupWarning}</Text>
      <Button
        label={gt("Don't warn again for this project")}
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
