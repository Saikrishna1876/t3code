import type { CodespacesOperation } from "@t3tools/contracts";

/** Missing capabilities wait for config; a loaded host without the flag is local-only. */
export function codespacesProjectSendBlockReason(
  capabilities: { readonly codespaces?: boolean } | null | undefined,
  query: { data: unknown | null; error: string | null; isPending: boolean },
): string | null {
  if (capabilities == null) return "Checking execution location";
  if (capabilities.codespaces !== true) return null;
  if (query.isPending || (query.data === null && query.error === null))
    return "Checking execution location";
  return query.error === null ? null : "Could not check execution location. Retry before sending.";
}

export const codespacesActionLabels = {
  create: "Creating Codespace",
  start: "Starting Codespace",
  connect: "Connecting workspace",
  stop: "Stopping Codespace",
  delete: "Deleting Codespace",
  rebuild: "Rebuilding Codespace",
  update: "Updating Codespace",
} as const;

/** Copy follows persisted lifecycle stages; it never estimates progress. */
export function codespacesOperationPresentation(operation: CodespacesOperation) {
  if (operation.status === "failed")
    return {
      label: "Codespace needs attention",
      description: operation.message,
      tone: "error" as const,
    };
  if (operation.status === "succeeded") {
    const labels = {
      create: "Codespace created",
      start: "Codespace resumed",
      connect: "Workspace connected",
      stop: "Codespace stopped",
      delete: "Codespace deleted",
      rebuild: "Codespace rebuilt",
      update: "Codespace updated",
    } as const;
    return {
      label: labels[operation.action],
      description:
        operation.action === "stop"
          ? "Compute has stopped. Storage usage continues until deletion."
          : operation.action === "delete"
            ? "Your local thread history remains on this T3 host."
            : "",
      tone: "success" as const,
    };
  }
  const stages: Record<string, { label: string; description: string }> = {
    accepted: {
      label: codespacesActionLabels[operation.action],
      description: "Request accepted by your T3 host.",
    },
    creating: {
      label: "Creating Codespace",
      description: "GitHub is building your container. This can take a few minutes.",
    },
    starting: { label: "Starting Codespace", description: "Waiting for GitHub to start compute." },
    bootstrapping: {
      label: "Connecting workspace",
      description: "Preparing remote tools and connecting over SSH.",
    },
    stopping: {
      label: "Stopping Codespace",
      description: "Waiting for GitHub to confirm compute has stopped.",
    },
    deleting: {
      label: "Deleting Codespace",
      description: "Waiting for GitHub to delete this workspace.",
    },
    rebuilding: {
      label: "Rebuilding Codespace",
      description: "Waiting for GitHub to rebuild the container.",
    },
  };
  return {
    ...(stages[operation.stage] ?? {
      label: codespacesActionLabels[operation.action],
      description: operation.message,
    }),
    tone: "info" as const,
  };
}

export function codespaceStateLabel(state: string | undefined) {
  switch (state) {
    case "Available":
      return "Running";
    case "Shutdown":
      return "Stopped";
    case "ShuttingDown":
      return "Stopping";
    case "Starting":
      return "Starting";
    case "Created":
    case "Queued":
    case "Provisioning":
      return "Preparing";
    case "Rebuilding":
      return "Rebuilding";
    case "Unavailable":
      return "Unavailable";
    case "Failed":
      return "Needs attention";
    default:
      return state ?? "Disconnected";
  }
}

/** Draft setup for local review before the user sends it to their agent. */
export function codespacesSetupPrompt(existingPrompt: string) {
  const instruction =
    "Make this project compatible with GitHub Codespaces. Inspect its stack and existing setup, then add or update .devcontainer/devcontainer.json and any required supporting files. Install the project's dependencies and tools, include Node.js 22.13 or later with npm and an SSH server for T3's remote executor, configure useful forwarded ports, and keep setup reproducible. Preserve existing dev-container configurations. Keep T3 thread history and provider login on my local machine; do not copy credentials or require a provider sign-in in the Codespace. Validate the configuration and explain any GitHub remote, branch, commit, or push steps I need before creating a Codespace. Do not create a Codespace or push changes without my approval.";
  if (existingPrompt.includes(instruction)) return existingPrompt;
  return existingPrompt.trim() ? `${existingPrompt}\n\n${instruction}` : instruction;
}
