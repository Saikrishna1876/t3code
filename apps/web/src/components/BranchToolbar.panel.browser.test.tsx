import { Atom } from "effect/reactivity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  codespacesSupported: false,
  canManageCodespaces: true,
  codespaceName: null as string | null,
  codespaceEligible: true,
  inventoryPending: false,
  prompt: "Existing request",
  setPrompt: vi.fn(),
  showContextMenu: vi.fn(),
  writeTextToClipboard: vi.fn(),
}));

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ contextMenu: { show: state.showContextMenu } })) as never,
}));
vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock(import("./BranchToolbarBranchSelector"), async (original) => ({
  ...(await original()),
  BranchToolbarBranchSelector: (() => null) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({
    environmentId: "local",
    projectId: "project",
    worktreePath: state.worktreePath,
  })) as never,
  useProject: (() => ({ id: "project", workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock(import("../composerDraftStore"), async (original) => ({
  ...(await original()),
  useComposerDraftStore: Object.assign(
    (select: (store: unknown) => unknown) =>
      select({ getDraftThreadByRef: () => null, setDraftThreadContext: vi.fn() }),
    {
      getState: () => ({
        getComposerDraft: () => ({ prompt: state.prompt }),
        setPrompt: state.setPrompt,
      }),
    },
  ) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({
    serverConfig: { environment: { capabilities: { codespaces: state.codespacesSupported } } },
  })) as never,
}));
vi.mock(import("../state/codespaces"), async (original) => ({
  ...(await original()),
  codespacesEnvironment: {
    run: { permissionAtom: () => Atom.make(state.canManageCodespaces) },
    project: () => "project",
    state: () => "state",
    list: () => "list",
  } as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((kind: string | null) => ({
    data:
      kind === "project"
        ? {
            eligible: state.codespaceEligible,
            repository: "owner/repo",
            ref: "main",
            name: state.codespaceName,
            connected: Boolean(state.codespaceName),
            devcontainerPaths: [".devcontainer/devcontainer.json"],
          }
        : kind === "list" && !state.inventoryPending
          ? {
              codespaces: state.codespaceName
                ? [
                    {
                      name: state.codespaceName,
                      repository: "owner/repo",
                      branch: "main",
                      state: "Available",
                    },
                  ]
                : [],
            }
          : kind === "state"
            ? {
                operations: [],
                configuration: { agentAccessEnabled: false },
              }
            : null,
    error: null,
    isPending: kind === "list" && state.inventoryPending,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => vi.fn(),
}));

import { BranchToolbar } from "./BranchToolbar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.worktreePath = "/tmp/worktree";
  state.codespacesSupported = false;
  state.canManageCodespaces = true;
  state.codespaceName = null;
  state.codespaceEligible = true;
  state.inventoryPending = false;
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<ComponentProps<typeof BranchToolbar>>) {
  return act(async () =>
    root.render(
      <BranchToolbar
        layout="panel"
        panelSection="workspace"
        environmentId={EnvironmentId.make("local")}
        threadId={ThreadId.make("thread")}
        showGitControls
        envMode="local"
        envLocked={false}
        startFromOrigin={false}
        onStartFromOriginChange={vi.fn()}
        onEnvModeChange={vi.fn()}
        {...props}
      />,
    ),
  );
}

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  const onEnvironmentChange = vi.fn();
  await render({
    onEnvironmentChange,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toBe("local");
  expect(container.querySelectorAll("button")).toHaveLength(1);

  // A ctrl-click is a macOS secondary click; it must not open the menu.
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();

  await userEvent.click(trigger);
  await expect
    .element(page.getByRole("menuitemradio", { name: "New worktree" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.click(page.getByRole("menuitemradio", { name: "remote" }));
  expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    state.worktreePath = worktreePath;
    await render({ envMode });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(copiedPath !== null);
    if (copiedPath === null) {
      expect(state.showContextMenu).not.toHaveBeenCalled();
      expect(state.writeTextToClipboard).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path"),
      );
    }
  },
);

it.each([
  { bound: false, eligible: true, inventoryPending: false },
  { bound: true, eligible: true, inventoryPending: false },
  { bound: false, eligible: false, inventoryPending: false },
  { bound: false, eligible: true, inventoryPending: true },
])("opens single-host Codespace flow for %j", async ({ bound, eligible, inventoryPending }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.codespacesSupported = true;
  state.codespaceName = bound ? "project-space" : null;
  state.codespaceEligible = eligible;
  state.inventoryPending = inventoryPending;
  state.setPrompt.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onEnvironmentChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <BranchToolbar
          layout="panel"
          panelSection="workspace"
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          showGitControls
          envMode="local"
          envLocked={bound}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
          onEnvironmentChange={onEnvironmentChange}
          availableEnvironments={[
            {
              environmentId: EnvironmentId.make("local"),
              projectId: ProjectId.make("project"),
              label: "Local host",
              isPrimary: true,
              machine: "server",
            },
          ]}
        />,
      ),
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await userEvent.click(container.querySelector<HTMLButtonElement>("button")!);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
      entry.textContent?.includes("Codespace"),
    );
    expect(item).toBeDefined();
    await userEvent.click(item!);
    const dialog = document.querySelector('[role="dialog"]');
    if (eligible || bound) {
      expect(dialog?.textContent).toContain("Project Codespace");
      expect(dialog?.textContent).toContain(
        bound ? "Stop Codespace" : "Create a Codespace for this project",
      );
      if (inventoryPending) {
        const create = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("New Codespace"),
        );
        expect(create?.disabled).toBe(false);
      }
      expect(state.setPrompt).not.toHaveBeenCalled();
    } else {
      expect(document.querySelector('[role="dialog"]:not([data-closed])')).toBeNull();
      expect(state.setPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread" }),
        expect.stringContaining("Existing request\n\nMake this project compatible"),
      );
    }
    expect(onEnvironmentChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.codespacesSupported = false;
    state.codespaceName = null;
    state.codespaceEligible = true;
    state.inventoryPending = false;
    vi.unstubAllGlobals();
  }
});

it("shows a paired client's bound target and locks worktrees without exposing lifecycle actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.codespacesSupported = true;
  state.codespaceName = "project-space";
  state.canManageCodespaces = false;
  state.worktreePath = null;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <BranchToolbar
          layout="panel"
          panelSection="workspace"
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          showGitControls
          envMode="local"
          envLocked={false}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
          availableEnvironments={[
            {
              environmentId: EnvironmentId.make("local"),
              projectId: ProjectId.make("project"),
              label: "Local host",
              isPrimary: true,
              machine: "server",
            },
          ]}
        />,
      );
    });
    expect(container.textContent).toContain("Codespace");
    expect(container.querySelector("button")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    state.codespacesSupported = false;
    state.codespaceName = null;
    state.canManageCodespaces = true;
    state.worktreePath = "/tmp/worktree";
    vi.unstubAllGlobals();
  }
});
