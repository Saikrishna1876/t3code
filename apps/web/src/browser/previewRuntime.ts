import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

/**
 * Where a tab the user opens should run. The desktop app draws its own
 * server's tabs natively, so those stay agent-drivable at no cost. A remote
 * environment's tabs would stream, so the desktop opens them in its own
 * browser instead: no latency, and it reaches what this computer reaches. The
 * user can move a tab to the environment when only it can reach the page.
 * Workspace loopback URLs always run on the environment that owns the port.
 */
export function previewRuntimeFor(
  environmentId: EnvironmentId,
  url?: string,
): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (url !== undefined) {
    try {
      if (isLoopbackHost(new URL(normalizePreviewUrl(url)).hostname)) return "server";
    } catch {
      // The preview open command reports invalid URLs through its existing error channel.
    }
  }
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
