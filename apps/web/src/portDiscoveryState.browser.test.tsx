import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../test/render";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { useDiscoveredPortsState } from "./portDiscoveryState";

const state = vi.hoisted(() => ({
  saved: false,
  requests: [] as Array<{ threadId?: ThreadId }>,
}));

vi.mock(import("./state/entities"), () => ({
  useQuietThreadShell: (() => (state.saved ? { codespaceName: "cloud" } : null)) as never,
}));
vi.mock(import("./state/preview"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const host = Atom.make(AsyncResult.success({ servers: [{ processName: "Host server" }] }));
  const remote = Atom.make(AsyncResult.success({ servers: [{ processName: "Remote server" }] }));
  const missing = Atom.make(AsyncResult.success({ servers: [] }));
  return {
    previewEnvironment: {
      discoveredServers: ({ input }: { input: { threadId?: ThreadId } }) => {
        state.requests.push(input);
        return input.threadId ? (state.saved ? remote : missing) : host;
      },
    } as never,
  };
});

const environmentId = EnvironmentId.make("host");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");

function Harness() {
  const discovery = useDiscoveredPortsState(environmentId, undefined, threadId);
  return (
    <div>
      <output aria-label="Discovery target">{discovery.threadId ?? "Host"}</output>
      {discovery.servers.map((server) => (
        <span key={server.processName}>{server.processName}</span>
      ))}
    </div>
  );
}

it.each([
  { draft: true, codespaceName: null, saved: false, expected: "Host server" },
  { draft: true, codespaceName: "cloud", saved: false, expected: null },
  { draft: true, codespaceName: null, saved: true, expected: "Remote server" },
  { draft: false, codespaceName: null, saved: false, expected: null },
])("discovers servers with draft=$draft, codespace=$codespaceName, saved=$saved", async (input) => {
  state.saved = input.saved;
  state.requests = [];
  useComposerDraftStore.setState({ draftThreadsByThreadKey: {}, draftsByThreadKey: {} });
  if (input.draft)
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        scopeProjectRef(environmentId, projectId),
        DraftId.make("preview-draft"),
        { threadId, codespaceName: input.codespaceName },
      );
  await using screen = await render(<Harness />);
  await expect
    .element(screen.getByLabelText("Discovery target"))
    .toHaveTextContent(input.draft && !input.saved ? "Host" : threadId);
  if (input.expected) await expect.element(screen.getByText(input.expected)).toBeVisible();
  else {
    await expect.element(screen.getByText("Host server")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Remote server")).not.toBeInTheDocument();
  }
  if (input.draft && input.codespaceName && !input.saved) expect(state.requests).toEqual([]);
  else expect(state.requests).toContainEqual(input.draft && !input.saved ? {} : { threadId });
});
