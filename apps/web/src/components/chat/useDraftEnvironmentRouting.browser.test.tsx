import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("../../hooks/useLoadBalancedEnvironment"), () => ({
  useLoadBalancedEnvironment: () => ({
    environmentId: EnvironmentId.make("routing-host"),
    pending: false,
    failed: false,
    refresh: () => undefined,
  }),
}));
vi.mock(import("../../hooks/useScratchProject"), () => ({
  useScratchProject: () => ({
    scratchWorkspaceRootFor: () => null,
    scratchEnvironmentId: (fallback: EnvironmentId | null) => fallback,
    openScratchProject: async () => null,
    startScratchThread: async () => undefined,
  }),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";

const environmentId = EnvironmentId.make("routing-host");
const projectId = ProjectId.make("routing-project");
const draftId = DraftId.make("routing-draft");
const environments = [
  { environmentId, projectId, label: "Host", isPrimary: true, machine: "server" as const },
];

function Harness({ attachments }: { readonly attachments: boolean }) {
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(draftId));
  const routing = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked: false,
    automaticEnvironment: draftThread?.environmentSelection === "auto",
    logicalProjectEnvironments: environments,
    environmentById: new Map(),
    providersByEnvironment: new Map(),
    loadBalancingSettings: { loadBalancingWeights: {} },
    referencedThreadContexts: [],
    activeProviderInstanceId: null,
    selectedProvider: ProviderDriverKind.make("codex"),
    composerHasAttachments: attachments,
    activeProjectKey: "routing-project",
    activeProjectIsScratch: false,
    projectGroupingSettings: selectProjectGroupingSettings(DEFAULT_UNIFIED_SETTINGS),
    sendInFlightRef: { current: false },
  });
  return (
    <BranchToolbarEnvironmentSelector
      environmentId={environmentId}
      availableEnvironments={environments}
      envLocked={false}
      codespaceLabel={draftThread?.codespaceName ?? undefined}
      codespaceName={draftThread?.codespaceName}
      onEnvironmentChange={routing.onEnvironmentChangeStable}
      onAutoEnvironment={routing.onAutoEnvironmentStable}
      autoEnvironmentLabel={routing.autoEnvironmentLabel}
    />
  );
}

it.each([false, true])(
  "returns a cloud draft to automatic routing with attachments=%s",
  async (attachments) => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      backgroundSubmissionThreadKeys: {},
      promotedDraftRedirects: {},
    });
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
      threadId: ThreadId.make("routing-thread"),
      codespaceName: "cloud",
      branch: "feature",
      worktreePath: "/virtual/cloud/worktree",
      environmentSelection: "manual",
    });
    store.setPrompt(draftId, "Keep this request");
    await using screen = await render(<Harness attachments={attachments} />);
    await userEvent.click(screen.getByRole("button", { name: "Run on" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Auto balance" }));
    await vi.waitFor(() => {
      expect(store.getDraftThread(draftId)).toMatchObject(
        attachments
          ? {
              codespaceName: "cloud",
              branch: "feature",
              worktreePath: "/virtual/cloud/worktree",
              environmentSelection: "manual",
            }
          : {
              environmentId,
              codespaceName: null,
              branch: null,
              worktreePath: null,
              environmentSelection: "auto",
              loadBalancedEnvironmentId: environmentId,
            },
      );
    });
    expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this request");
  },
);
