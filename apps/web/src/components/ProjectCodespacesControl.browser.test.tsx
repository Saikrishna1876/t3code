import "~/index.css";
import {
  EnvironmentId,
  ProjectId,
  type CodespacesConfiguration,
  type CodespacesProject,
  type CodespacesSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  snapshot: null as CodespacesSnapshot | null,
  project: null as CodespacesProject | null,
  inventoryMissing: false,
  run: vi.fn(),
  bind: vi.fn(),
  authorize: vi.fn(),
  options: vi.fn(),
  openThread: vi.fn(),
  setPrompt: vi.fn(),
  configure:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: CodespacesConfiguration;
      }) => Promise<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>
    >(),
}));
vi.mock(import("~/state/environments"), () => ({
  useEnvironment: (() => ({
    serverConfig: { environment: { capabilities: { codespaces: true } } },
  })) as never,
}));
vi.mock(import("~/state/entities"), () => ({
  useProjects: (() => [{ id: "project", environmentId: "local", title: "Project" }]) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => state.openThread,
}));
vi.mock(import("~/composerDraftStore"), async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    clearComposerDraftsEnvironment: vi.fn(),
    useComposerDraftStore: {
      getState: () => ({
        getComposerDraft: () => ({ prompt: "Existing request" }),
        setPrompt: state.setPrompt,
      }),
    } as never,
  };
});
vi.mock(import("~/components/settings/settingsLayout"), () => ({
  SettingsSection: ({
    title,
    children,
  }: {
    title: string;
    children: import("react").ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock(import("~/state/codespaces"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (key: string) => ({ key, permissionAtom: () => allowed });
  return {
    codespacesEnvironment: {
      run: command("run"),
      bind: command("bind"),
      authorize: command("authorize"),
      configure: command("configure"),
      options: command("options"),
      project: () => "project",
      state: () => "state",
      list: () => "list",
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { key: keyof typeof state }) => state[command.key]) as never,
}));
vi.mock(import("~/state/query"), () => ({
  useEnvironmentQuery: ((kind: string) => ({
    data:
      kind === "project"
        ? state.project
        : kind === "state"
          ? state.snapshot
          : {
              account: "example",
              codespaces: state.inventoryMissing
                ? []
                : [
                    {
                      name: "computer",
                      displayName: "Cloud computer",
                      state: "Shutdown",
                      machine: "basicLinux32gb",
                    },
                  ],
            },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));

import { ProjectCodespacesControl, CodespacesMenuItems } from "./ProjectCodespacesControl";
import { CodespacesSettings } from "./settings/CodespacesSettings";
import { Menu, MenuTrigger, MenuPopup } from "./ui/menu";
import { Button } from "./ui/button";

const local = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const view = () => (
  <CodespacesSettings
    environments={
      [
        {
          environmentId: local,
          label: "Host",
          serverConfig: { environment: { capabilities: { codespaces: true } } },
        },
      ] as never
    }
  />
);
const switchControl = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="switch"]')!;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
function setup() {
  state.inventoryMissing = false;
  for (const command of [
    state.run,
    state.bind,
    state.authorize,
    state.options,
    state.configure,
    state.openThread,
    state.setPrompt,
  ])
    command.mockReset();
  state.snapshot = {
    configuration: {
      releaseBaseUrl: "",
      archiveVersion: "",
      remoteScriptPath: "",
      publicUrlTemplate: "",
      networkAccess: false,
      agentAccessEnabled: false,
    },
    operations: [],
    environments: [
      {
        name: "computer",
        account: "example",
        codespaceId: 1,
        environmentId: null,
        localPort: 1234,
        remotePort: 3773,
        workspacePath: "/workspaces",
        connected: false,
      },
    ],
  };
  state.project = {
    projectId,
    eligible: true,
    reason: "",
    repository: "",
    ref: "main",
    devcontainerPaths: [],
    name: null,
    connected: false,
  };
  state.run.mockResolvedValue(
    AsyncResult.success({
      action: "start",
      name: "computer",
      clientRequestId: "request-123",
      status: "running",
      stage: "accepted",
      message: "",
      createdAt: "2026-10-29T00:00:00Z",
    }),
  );
  state.bind.mockResolvedValue(AsyncResult.success(state.project));
  state.options.mockResolvedValue(
    AsyncResult.success({
      machines: [
        { name: "basicLinux32gb", displayName: "2 cores", cpus: 2, memoryBytes: 8000000000 },
      ],
      devcontainers: [],
    }),
  );
  state.openThread.mockResolvedValue({ draftId: "draft-123", threadId: "thread-123" });
}

it("creates a blank computer from settings before any project is attached", async () => {
  setup();
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "New Codespace", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Create blank computer" }));
  await userEvent.click(page.getByRole("button", { name: "Create computer", exact: true }));
  expect(state.options).toHaveBeenCalledWith({ environmentId: local, input: {} });
  expect(state.run).toHaveBeenCalledWith({
    environmentId: local,
    input: expect.objectContaining({ action: "create", machine: "basicLinux32gb" }),
  });
  expect(state.run.mock.calls[0]![0].input).not.toHaveProperty("projectId");
  expect(state.run.mock.calls[0]![0].input).not.toHaveProperty("repository");
  expect(state.run.mock.calls[0]![0].input).not.toHaveProperty("devcontainerPath");
});

it("keeps a stopped computer in the picker and starts it for this project", async () => {
  setup();
  await using screen = await render(
    <Menu>
      <MenuTrigger render={<Button />}>Run on</MenuTrigger>
      <MenuPopup>
        <CodespacesMenuItems environmentId={local} projectId={projectId} />
      </MenuPopup>
    </Menu>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Run on" }));
  await expect.element(page.getByRole("menuitem", { name: /Cloud computer/ })).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: /Cloud computer.*Start/ }));
  expect(state.run).toHaveBeenCalledWith({
    environmentId: local,
    input: expect.objectContaining({ action: "start", name: "computer", projectId }),
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("dismisses a setup warning without losing the binding and offers restoration", async () => {
  setup();
  state.project = {
    ...state.project!,
    name: "computer",
    setupWarning: "Project added. Setup exceeded its memory limit.",
    setupWarningDismissed: false,
  };
  const projectView = () => (
    <ProjectCodespacesControl environmentId={local} projectId={projectId} />
  );
  await using screen = await render(projectView());
  await userEvent.click(screen.getByRole("button", { name: "Don't warn again for this project" }));
  expect(state.bind).toHaveBeenCalledWith({
    environmentId: local,
    input: { projectId, name: "computer", dismissSetupWarning: true },
  });
  state.project = { ...state.project, setupWarningDismissed: true };
  await screen.rerender(projectView());
  await expect.element(screen.getByRole("button", { name: "Show setup warnings" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show setup warnings" }));
  expect(state.bind).toHaveBeenLastCalledWith({
    environmentId: local,
    input: { projectId, name: "computer", dismissSetupWarning: false },
  });
});

it("allows returning to local work after the bound computer disappears", async () => {
  setup();
  state.inventoryMissing = true;
  state.project = { ...state.project!, name: "computer" };
  await using screen = await render(
    <Menu>
      <MenuTrigger render={<Button />}>Run on</MenuTrigger>
      <MenuPopup>
        <CodespacesMenuItems environmentId={local} projectId={projectId} />
      </MenuPopup>
    </Menu>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Run on" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Work locally" }));
  expect(state.bind).toHaveBeenCalledWith({
    environmentId: local,
    input: { projectId, name: null },
  });
});

it("opens an unsent cloud setup draft while preserving existing text", async () => {
  setup();
  await using screen = await render(
    <ProjectCodespacesControl environmentId={local} projectId={projectId} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Prepare cloud setup" }));
  expect(state.setPrompt).toHaveBeenCalledWith(
    "draft-123",
    expect.stringContaining("Existing request\n\nMake this project compatible"),
  );
  expect(state.run).not.toHaveBeenCalled();
});

it("keeps the optimistic agent toggle through a delayed subscription", async () => {
  setup();
  const save = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(save.promise);
  await using screen = await render(view());
  await act(async () => switchControl(screen.container).click());
  expect(switchControl(screen.container).getAttribute("aria-checked")).toBe("true");
  expect(switchControl(screen.container).matches('[aria-disabled="true"]')).toBe(true);
  const saved = {
    ...state.snapshot!,
    configuration: { ...state.snapshot!.configuration, agentAccessEnabled: true },
  };
  await act(async () => save.resolve(AsyncResult.success(saved)));
  expect(switchControl(screen.container).getAttribute("aria-checked")).toBe("true");
  state.snapshot = saved;
  await screen.rerender(view());
  state.snapshot = {
    ...saved,
    configuration: { ...saved.configuration, agentAccessEnabled: false },
  };
  await screen.rerender(view());
  expect(switchControl(screen.container).getAttribute("aria-checked")).toBe("false");
});

it("rolls back failed agent access saves and allows retry", async () => {
  setup();
  const save = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(save.promise);
  await using screen = await render(view());
  await act(async () => switchControl(screen.container).click());
  await act(async () =>
    save.resolve(AsyncResult.failure(Cause.fail(new Error("Permission denied")))),
  );
  expect(switchControl(screen.container).getAttribute("aria-checked")).toBe("false");
  expect(switchControl(screen.container).matches('[aria-disabled="true"]')).toBe(false);
  expect(screen.container.querySelector('[role="status"]')?.textContent).toBe("Permission denied");
});
