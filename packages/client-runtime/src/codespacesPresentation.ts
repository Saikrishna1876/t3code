import type { CodespacesOperation } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Missing capabilities wait for config; a loaded host without the flag is local-only. */
export function codespacesProjectSendBlockReason(
  capabilities: { readonly codespaces?: boolean } | null | undefined,
  query: { data: unknown | null; error: string | null; isPending: boolean },
  resolve: MFunctionType = mFallback,
): string | null {
  const checking = () => resolve(msg("Checking execution location"));
  if (capabilities == null) return checking();
  if (capabilities.codespaces !== true) return null;
  if (query.isPending || (query.data === null && query.error === null)) return checking();
  return query.error === null
    ? null
    : resolve(msg("Could not check execution location. Retry before sending."));
}

const codespacesActionLabels = {
  create: msg("Creating Codespace"),
  start: msg("Starting Codespace"),
  connect: msg("Connecting workspace"),
  stop: msg("Stopping Codespace"),
  delete: msg("Deleting Codespace"),
  rebuild: msg("Rebuilding Codespace"),
  update: msg("Updating Codespace"),
} as const;

const codespacesSucceededLabels = {
  create: msg("Codespace created"),
  start: msg("Codespace resumed"),
  connect: msg("Workspace connected"),
  stop: msg("Codespace stopped"),
  delete: msg("Codespace deleted"),
  rebuild: msg("Codespace rebuilt"),
  update: msg("Codespace updated"),
} as const;

const codespacesStages: Record<string, { label: string; description: string }> = {
  creating: {
    label: msg("Creating Codespace"),
    description: msg("GitHub is building your container. This can take a few minutes."),
  },
  starting: {
    label: msg("Starting Codespace"),
    description: msg("Waiting for GitHub to start compute."),
  },
  bootstrapping: {
    label: msg("Connecting workspace"),
    description: msg("Preparing remote tools and connecting over SSH."),
  },
  stopping: {
    label: msg("Stopping Codespace"),
    description: msg("Waiting for GitHub to confirm compute has stopped."),
  },
  deleting: {
    label: msg("Deleting Codespace"),
    description: msg("Waiting for GitHub to delete this workspace."),
  },
  rebuilding: {
    label: msg("Rebuilding Codespace"),
    description: msg("Waiting for GitHub to rebuild the container."),
  },
};

/** Copy follows persisted lifecycle stages; it never estimates progress. */
export function codespacesOperationPresentation(
  operation: CodespacesOperation,
  resolve: MFunctionType = mFallback,
) {
  if (operation.status === "failed")
    return {
      label: resolve(msg("Codespace needs attention")),
      description: operation.message,
      tone: "error" as const,
      logHelpUrl: ["create", "start", "connect", "rebuild"].includes(operation.action)
        ? "https://docs.github.com/en/codespaces/troubleshooting/github-codespaces-logs#creation-logs"
        : null,
    };
  if (operation.status === "succeeded")
    return {
      label: resolve(codespacesSucceededLabels[operation.action]),
      description:
        operation.action === "stop"
          ? resolve(msg("Compute has stopped. Storage usage continues until deletion."))
          : operation.action === "delete"
            ? resolve(msg("Your local thread history remains on this T3 host."))
            : "",
      tone: "success" as const,
      logHelpUrl: null,
    };
  const stage =
    operation.stage === "accepted"
      ? {
          label: codespacesActionLabels[operation.action],
          description: msg("Request accepted by your T3 host."),
        }
      : codespacesStages[operation.stage];
  return {
    ...(stage
      ? { label: resolve(stage.label), description: resolve(stage.description) }
      : {
          label: resolve(codespacesActionLabels[operation.action]),
          description: operation.message,
        }),
    tone: "info" as const,
    logHelpUrl: null,
  };
}

export function codespaceStateLabel(state: string | undefined, resolve: MFunctionType = mFallback) {
  switch (state) {
    case "Available":
      return resolve(msg("Running", { $context: "GitHub Codespace state" }));
    case "Shutdown":
      return resolve(msg("Stopped", { $context: "GitHub Codespace state" }));
    case "ShuttingDown":
      return resolve(msg("Stopping", { $context: "GitHub Codespace state" }));
    case "Starting":
      return resolve(msg("Starting", { $context: "GitHub Codespace state" }));
    case "Created":
    case "Queued":
    case "Provisioning":
      return resolve(msg("Preparing", { $context: "GitHub Codespace state" }));
    case "Rebuilding":
      return resolve(msg("Rebuilding", { $context: "GitHub Codespace state" }));
    case "Unavailable":
      return resolve(msg("Unavailable", { $context: "GitHub Codespace state" }));
    case "Failed":
      return resolve(msg("Needs attention", { $context: "GitHub Codespace state" }));
    default:
      return state ?? resolve(msg("Disconnected", { $context: "GitHub Codespace state" }));
  }
}

/** Draft setup for local review before the user sends it to their agent. */
export function codespacesSetupPrompt(existingPrompt: string) {
  const instruction =
    "Make this project compatible with GitHub Codespaces. Inspect its stack and existing setup, then add or update .devcontainer/devcontainer.json and supporting files only where needed. The Codespace is a shared computer created from a blank template, with projects under /workspaces/{project_name}. A devcontainer is optional. Preserve existing configurations. Do not rebuild, replace, stop, or delete the shared computer. Explain image or feature requirements that cannot be applied safely to it. Check available memory before proposing dependency installation. Use enforceable memory limits for setup commands; if those are unavailable or installation would exceed them, explain how the user can finish setup manually. Do not run an unrestricted dependency installation. Keep T3 thread history and provider login on my T3 host; do not copy credentials or require provider sign-in in the Codespace. Validate the configuration and explain what I need to commit before adding this project to a computer from Settings, Environments, Codespaces. Do not create a Codespace or push changes without my approval.";
  if (existingPrompt.includes(instruction)) return existingPrompt;
  return existingPrompt.trim() ? `${existingPrompt}\n\n${instruction}` : instruction;
}
