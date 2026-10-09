import type { CodespacesOperation } from "@t3tools/contracts";

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
