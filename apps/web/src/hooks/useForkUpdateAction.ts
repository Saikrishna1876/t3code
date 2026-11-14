import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";
import type { DraftId } from "../composerDraftStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { ensureClientSettingsHydrated, getClientSettings } from "./useSettings";
import { readProjects } from "../state/entities";
import { toastManager } from "../components/ui/toast";

const useAutoSend = create<{
  request: { draftId: DraftId; prompt: string } | null;
}>(() => ({ request: null }));

export function useForkUpdateAction() {
  const newThread = useNewThreadHandler();
  const navigate = useNavigate();
  return async () => {
    try {
      await ensureClientSettingsHydrated();
      const settings = getClientSettings();
      const project = settings.forkUpdateProject;
      const prompt = settings.forkUpdatePrompt.trim();
      if (
        !project ||
        !prompt ||
        !readProjects().some(
          (item) =>
            item.id === project.projectId &&
            item.environmentId === project.environmentId &&
            !item.archivedAt,
        )
      ) {
        await navigate({ to: "/settings/about" });
        toastManager.add({
          type: "info",
          title: "Choose a fork update project and enter a prompt in Settings.",
        });
        return;
      }
      const opened = await newThread(project, { prompt, forceNew: true });
      if (opened && !settings.forkUpdateDraftOnly) {
        useAutoSend.setState({ request: { draftId: opened.draftId, prompt } });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open fork update thread",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };
}

export function useForkUpdateAutoSend(input: {
  draftId: DraftId | null;
  prompt: string;
  disabled: boolean;
  submit: () => boolean;
}) {
  const { draftId, prompt, disabled, submit } = input;
  const request = useAutoSend((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers a one-shot update-button send request after the destination composer is ready
  useEffect(() => {
    if (!request || request.draftId !== draftId || disabled) return;
    useAutoSend.setState({ request: null });
    const current = useComposerDraftStore.getState().getComposerDraft(request.draftId);
    if (current?.prompt === request.prompt && prompt === request.prompt) submit();
  }, [request, draftId, prompt, disabled, submit]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending send when its destination composer leaves the screen
  useEffect(
    () => () => {
      if (useAutoSend.getState().request?.draftId === draftId)
        useAutoSend.setState({ request: null });
    },
    [draftId],
  );
}
