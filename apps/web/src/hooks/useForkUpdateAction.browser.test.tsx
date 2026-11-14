import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { useForkUpdateAction, useForkUpdateAutoSend } from "./useForkUpdateAction";
import type { DraftId } from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  settings: {
    forkUpdateDraftOnly: true,
    forkUpdatePrompt: "Update fork",
    forkUpdateProject: { environmentId: "local", projectId: "fork" },
  },
  prompt: "Update fork",
  open: vi.fn(),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.open }));
vi.mock("./useSettings", () => ({
  ensureClientSettingsHydrated: async () => {},
  getClientSettings: () => mocks.settings,
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [{ id: "fork", environmentId: "local", archivedAt: null }],
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({ getComposerDraft: () => ({ prompt: mocks.prompt }) }),
  },
}));
function setup(draftOnly: boolean) {
  mocks.settings = {
    forkUpdateDraftOnly: draftOnly,
    forkUpdatePrompt: "Update fork",
    forkUpdateProject: { environmentId: "local", projectId: "fork" },
  };
  mocks.prompt = "Update fork";
  mocks.open.mockReset().mockResolvedValue({ draftId: "new-draft" });
}
function Control({ submit, disabled = false }: { submit: () => boolean; disabled?: boolean }) {
  const open = useForkUpdateAction();
  useForkUpdateAutoSend({
    draftId: "new-draft" as DraftId,
    prompt: mocks.prompt,
    disabled,
    submit,
  });
  return <button onClick={() => void open()}>Update fork</button>;
}

describe("fork update launch", () => {
  it("keeps the prompt unsent by default and sends once when draft review is off", async () => {
    for (const draftOnly of [true, false]) {
      setup(draftOnly);
      const submit = vi.fn(() => true);
      await using screen = await render(<Control submit={submit} />);
      await userEvent.click(screen.getByRole("button", { name: "Update fork" }));
      await vi.waitFor(() =>
        expect(mocks.open).toHaveBeenCalledWith(mocks.settings.forkUpdateProject, {
          prompt: "Update fork",
          forceNew: true,
        }),
      );
      if (draftOnly) expect(submit).not.toHaveBeenCalled();
      else await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      await screen.rerender(<Control submit={submit} />);
      expect(submit).toHaveBeenCalledTimes(draftOnly ? 0 : 1);
    }
  });

  it("does not send edited text or retain a send request after leaving the composer", async () => {
    setup(false);
    const submit = vi.fn(() => true);
    await using screen = await render(<Control submit={submit} disabled />);
    await userEvent.click(screen.getByRole("button", { name: "Update fork" }));
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    mocks.prompt = "User edited this";
    await screen.rerender(<Control submit={submit} />);
    expect(submit).not.toHaveBeenCalled();
    await screen.rerender(<Control submit={submit} disabled />);
    await userEvent.click(screen.getByRole("button", { name: "Update fork" }));
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    await screen.rerender(<div />);
    mocks.prompt = "Update fork";
    await screen.rerender(<Control submit={submit} />);
    expect(submit).not.toHaveBeenCalled();
  });
});
