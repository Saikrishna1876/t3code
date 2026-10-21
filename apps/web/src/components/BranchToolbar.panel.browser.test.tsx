import { Atom } from "effect/reactivity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render as renderUi } from "../../test/render";

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
vi.mock(import("./BranchToolbarBranchSelector"), () => ({
  BranchToolbarBranchSelector: (() => null) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: (() => ({ id: "project", workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock(import("../composerDraftStore"), async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
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
  };
});
vi.mock(import("../state/environments"), () => ({
  useEnvironment: (() => ({
    serverConfig: { environment: { capabilities: { codespaces: state.codespacesSupported } } },
  })) as never,
}));
vi.mock(import("../state/codespaces"), () => {
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    codespacesEnvironment: {
      authorize: { permissionAtom: () => (state.canManageCodespaces ? allowed : denied) },
      run: { permissionAtom: () => (state.canManageCodespaces ? allowed : denied) },
      project: () => "project",
      state: () => "state",
      list: () => "list",
    } as never,
  };
});
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

function setup() {
  state.codespacesSupported = false;
  state.canManageCodespaces = true;
  state.codespaceName = null;
  state.codespaceEligible = true;
  state.inventoryPending = false;
}

function render(
  props: Partial<ComponentProps<typeof BranchToolbar>>,
  { worktreePath = "/tmp/worktree" }: { worktreePath?: string | null } = {},
) {
  state.worktreePath = worktreePath;
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
  return renderUi(
    <BranchToolbar
      layout="panel"
      panelSection="workspace"
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      projectId={ProjectId.make("project")}
      worktreePath={state.worktreePath}
      isServerThread
      showGitControls
      envMode="local"
      envLocked={false}
      startFromOrigin={false}
      onStartFromOriginChange={vi.fn()}
      onEnvModeChange={vi.fn()}
      {...props}
    />,
  );
}

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  setup();
  const onEnvironmentChange = vi.fn();
  await using screen = await render({
    onEnvironmentChange,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  const trigger = screen.container.querySelector("button")!;
  expect(trigger.textContent).toBe("local");
  expect(screen.container.querySelectorAll("button")).toHaveLength(1);

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

it("shows a started thread's primary machine as a static label in the composer", async () => {
  setup();
  await using screen = await render({
    layout: "composer",
    showGitControls: false,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  expect(screen.container.textContent).toBe("local");
  expect(screen.container.querySelector("button")).toBeNull();
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
  ["worktree", "C:/repo/worktree", String.raw`C:\repo\worktree`],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    setup();
    await using screen = await render({ envMode }, { worktreePath });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      screen.container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
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
  setup();
  state.codespacesSupported = true;
  state.codespaceName = bound ? "project-space" : null;
  state.codespaceEligible = eligible;
  state.inventoryPending = inventoryPending;
  state.setPrompt.mockClear();
  const onEnvironmentChange = vi.fn();
  await using screen = await render({
    envLocked: bound,
    onEnvironmentChange,
    availableEnvironments: [
      {
        environmentId: EnvironmentId.make("local"),
        projectId: ProjectId.make("project"),
        label: "Local host",
        isPrimary: true,
        machine: "server",
      },
    ],
  });
  expect(screen.container.querySelectorAll("button")).toHaveLength(1);
  await userEvent.click(screen.container.querySelector<HTMLButtonElement>("button")!);
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
});

it("shows a paired client's bound target and locks worktrees without exposing lifecycle actions", async () => {
  setup();
  state.codespacesSupported = true;
  state.codespaceName = "project-space";
  state.canManageCodespaces = false;
  await using screen = await render(
    {
      availableEnvironments: [
        {
          environmentId: EnvironmentId.make("local"),
          projectId: ProjectId.make("project"),
          label: "Local host",
          isPrimary: true,
          machine: "server",
        },
      ],
    },
    { worktreePath: null },
  );
  expect(screen.container.textContent).toContain("Codespace");
  expect(screen.container.querySelector("button")).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
