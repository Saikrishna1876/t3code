import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
  type HostResourcesSnapshot,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";
import { useQuietThreadShell } from "./state/entities";
import { useComposerDraftStore } from "./composerDraftStore";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

interface DiscoveredPortsState {
  readonly threadId: ThreadId | null | undefined;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly configuredUrlProbing: boolean;
  readonly resources: HostResourcesSnapshot | undefined;
  readonly codespaceName: string | undefined;
  readonly error: "disconnected" | undefined;
}

export function boundConfiguredLocalServerUrls(
  urls: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (raw.length === 0 || raw.length > PREVIEW_URL_MAX_LENGTH || raw.trim().length !== raw.length)
      continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!isLoopbackHost(url.hostname) || url.href.length > PREVIEW_URL_MAX_LENGTH) continue;
      const resourceUrl = new URL(url.href);
      resourceUrl.hash = "";
      if (seen.has(resourceUrl.href)) continue;
      seen.add(resourceUrl.href);
      bounded.push(url.href);
      if (bounded.length >= CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS) break;
    } catch {}
  }
  return bounded;
}

export function useDiscoveredPortsState(
  environmentId: EnvironmentId | null,
  configuredUrls?: ReadonlyArray<string>,
  threadId?: ThreadId | null,
): DiscoveredPortsState {
  const threadRef = environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null;
  const thread = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const unsavedDraft = thread === null ? draft : null;
  const targetThreadId = unsavedDraft ? null : threadId;
  const boundedConfiguredUrls = boundConfiguredLocalServerUrls(configuredUrls);
  const query = useEnvironmentQuery(
    environmentId === null || unsavedDraft?.codespaceName
      ? null
      : previewEnvironment.discoveredServers({
          environmentId,
          input: {
            ...(boundedConfiguredUrls.length ? { configuredUrls: boundedConfiguredUrls } : {}),
            ...(targetThreadId ? { threadId: targetThreadId } : {}),
          },
        }),
  );
  return {
    threadId: targetThreadId,
    servers: query.data?.servers ?? EMPTY_PORTS,
    configuredUrlProbing: query.data?.configuredUrlProbing === true,
    resources: query.data?.resources,
    codespaceName: query.data?.codespaceName,
    error: query.data?.error,
  };
}
