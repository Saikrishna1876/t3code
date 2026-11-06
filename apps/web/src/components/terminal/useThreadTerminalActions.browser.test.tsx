import { EnvironmentId, ProjectId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadTerminalActions } from "./useThreadTerminalActions";
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
} from "../PersistentThreadTerminals";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";

const fixture = vi.hoisted(() => ({
  server: false,
  codespaceName: null as string | null,
  worktreePath: null as string | null,
  open: vi.fn(),
  close: vi.fn(),
  sessions: [] as Array<{
    target: { terminalId: string };
    state: { summary: TerminalSummary };
  }>,
}));

vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () =>
    fixture.server
      ? {
          environmentId: "host",
          projectId: "project",
          codespaceName: fixture.codespaceName,
          worktreePath: fixture.worktreePath,
        }
      : null,
  useProject: () => ({ workspaceRoot: "/repo" }),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => fixture.sessions,
}));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write", close: "close" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "open" ? fixture.open : fixture.close),
}));
// Exercise launch-location selection without loading a terminal renderer or connecting a client.
vi.mock("../ThreadTerminalDrawer", () => ({
  default: (props: { onNewTerminal: () => void; mode?: string }) => (
    <button onClick={props.onNewTerminal}>{props.mode ?? "drawer"}</button>
  ),
}));

const environmentId = EnvironmentId.make("host");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const threadRef = scopeThreadRef(environmentId, threadId);

function Harness({ surface }: { surface?: "drawer" | "panel" }) {
  const actions = useThreadTerminalActions(threadRef);
  return (
    <>
      <button onClick={() => actions.launchTerminal({ place: () => undefined })}>Launch</button>
      <button
        onClick={() => actions.launchTerminal({ terminalId: "term-1", place: () => undefined })}
      >
        Reuse
      </button>
      {surface !== "panel" && (
        <PersistentThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadId}
          active
          composerHeight={0}
          launchContext={null}
          splitShortcutLabel={undefined}
          splitVerticalShortcutLabel={undefined}
          newShortcutLabel={undefined}
          closeShortcutLabel={undefined}
          keybindings={[]}
          onAddTerminalContext={() => undefined}
        />
      )}
      {surface !== "drawer" && (
        <PersistentThreadTerminalPanel
          visible
          threadRef={threadRef}
          surface={{
            kind: "terminal",
            id: "terminal:panel",
            resourceId: "term-1",
            terminalIds: fixture.sessions.map((entry) => entry.target.terminalId),
            activeTerminalId: "term-1",
          }}
          launchContext={null}
          keybindings={[]}
          onAddTerminalContext={() => undefined}
          onSplitTerminal={() => undefined}
          onSplitTerminalVertical={() => undefined}
          onNewTerminal={() => actions.launchTerminal({ place: () => undefined })}
          onActiveTerminalChange={() => undefined}
          onCloseTerminal={() => undefined}
        />
      )}
    </>
  );
}

it.each([
  { server: false, codespaceName: "cloud", worktreePath: null },
  { server: true, codespaceName: "cloud", worktreePath: null },
  { server: true, codespaceName: "cloud", worktreePath: "/repo/.git/t3-codespaces/cloud/tree" },
  { server: true, codespaceName: null, worktreePath: null },
  { server: true, codespaceName: null, worktreePath: "/repo-host-tree" },
])(
  "launches terminals on selected computer $codespaceName, server=$server, worktree=$worktreePath",
  async (input) => {
    Object.assign(fixture, input);
    fixture.sessions = [];
    fixture.open.mockReset().mockResolvedValue({ _tag: "Success" });
    useComposerDraftStore.setState({ draftThreadsByThreadKey: {}, draftsByThreadKey: {} });
    useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        scopeProjectRef(environmentId, projectId),
        DraftId.make("terminal-draft"),
        { threadId, codespaceName: input.codespaceName, worktreePath: input.worktreePath },
      );
    await using screen = await render(<Harness />);
    const root = input.codespaceName ? "/repo/.git/t3-codespaces/cloud" : "/repo";
    for (const name of ["Launch", "drawer", "panel"]) {
      await userEvent.click(screen.getByRole("button", { name, exact: true }));
      expect(fixture.open).toHaveBeenLastCalledWith({
        environmentId,
        input: {
          threadId,
          terminalId: expect.any(String),
          cwd: input.worktreePath ?? root,
          ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
          env: {
            T3CODE_PROJECT_ROOT: root,
            ...(input.worktreePath ? { T3CODE_WORKTREE_PATH: input.worktreePath } : {}),
          },
        },
      });
    }
  },
);

it.each(["drawer", "panel"] as const)(
  "opens a remote %s terminal after selecting a Codespace with a host shell running",
  async (surface) => {
    Object.assign(fixture, { server: false, codespaceName: null, worktreePath: null });
    fixture.open.mockReset().mockResolvedValue({ _tag: "Success" });
    fixture.close.mockReset().mockResolvedValue({ _tag: "Success" });
    fixture.sessions = [
      {
        target: { terminalId: "term-1" },
        state: {
          summary: {
            threadId,
            terminalId: "term-1",
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 123,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: true,
            label: "Host build",
            updatedAt: "2026-11-06T00:00:00.000Z",
          },
        },
      },
    ];
    useComposerDraftStore.setState({ draftThreadsByThreadKey: {}, draftsByThreadKey: {} });
    useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
    const draftId = DraftId.make("terminal-draft");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, { threadId });
    useTerminalUiStateStore.getState().ensureTerminal(threadRef, "term-1", { open: true });
    await using screen = await render(<Harness surface={surface} />);
    expect(fixture.open).not.toHaveBeenCalled();
    await act(() => store.setDraftThreadContext(draftId, { codespaceName: "cloud" }));
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1));
    expect(fixture.open.mock.calls[0]?.[0].input).toMatchObject({
      threadId,
      terminalId: "term-2",
      cwd: "/repo/.git/t3-codespaces/cloud",
      env: { T3CODE_PROJECT_ROOT: "/repo/.git/t3-codespaces/cloud" },
    });
    expect(fixture.close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reuse", exact: true }));
    expect(fixture.open.mock.lastCall?.[0].input.terminalId).not.toBe("term-1");
  },
);
