import { describe, expect, it } from "vite-plus/test";
import type { CodespacesOperation } from "@t3tools/contracts";
import {
  codespacesOperationPresentation,
  codespaceStateLabel,
  codespacesSetupPrompt,
  codespacesProjectSendBlockReason,
} from "./codespacesPresentation.ts";

const stopping: CodespacesOperation = {
  clientRequestId: "test-stop-request",
  action: "stop",
  name: "test-workspace",
  status: "running",
  stage: "stopping",
  message: "Requesting stop from GitHub.",
  createdAt: "2026-10-09T10:00:00.000Z",
};

describe("execution location readiness", () => {
  it("blocks first reads, refreshes, and unloaded configuration until location is confirmed", () => {
    const unresolved = { data: null, isPending: false, error: null };
    expect(codespacesProjectSendBlockReason({ codespaces: true }, unresolved)).toBe(
      "Checking execution location",
    );
    expect(codespacesProjectSendBlockReason(undefined, unresolved)).toBe(
      "Checking execution location",
    );
    expect(
      codespacesProjectSendBlockReason(
        { codespaces: true },
        {
          data: { name: null },
          isPending: true,
          error: null,
        },
      ),
    ).toBe("Checking execution location");
  });
  it("allows older hosts that omit the flag only after their configuration loads", () => {
    const idleQuery = { data: null, isPending: false, error: null };
    expect(codespacesProjectSendBlockReason(undefined, idleQuery)).toBe(
      "Checking execution location",
    );
    expect(codespacesProjectSendBlockReason(null, idleQuery)).toBe("Checking execution location");
    expect(codespacesProjectSendBlockReason({}, idleQuery)).toBeNull();
    expect(codespacesProjectSendBlockReason({ codespaces: true }, idleQuery)).toBe(
      "Checking execution location",
    );
  });
  it("blocks failed reads even with stale local status; retry then restores sending", () => {
    const data = { name: null };
    const failed = { data, isPending: false, error: "Disconnected" };
    expect(codespacesProjectSendBlockReason({ codespaces: true }, failed)).toContain(
      "Retry before sending",
    );
    expect(
      codespacesProjectSendBlockReason({ codespaces: true }, { ...failed, isPending: true }),
    ).toBe("Checking execution location");
    expect(
      codespacesProjectSendBlockReason(
        { codespaces: true },
        {
          data: { name: "space" },
          isPending: false,
          error: null,
        },
      ),
    ).toBeNull();
    expect(
      codespacesProjectSendBlockReason(
        { codespaces: true },
        { data, isPending: false, error: null },
      ),
    ).toBeNull();
  });
  it("preserves local-only hosts and projectless drafts without a binding query", () => {
    expect(
      codespacesProjectSendBlockReason(
        { codespaces: false },
        { data: null, isPending: true, error: "Offline" },
      ),
    ).toBeNull();
  });
});

describe("Codespace lifecycle feedback", () => {
  it("keeps a stop request pending until the operation succeeds", () => {
    const waiting = codespacesOperationPresentation(stopping);
    expect(waiting.tone).toBe("info");
    expect(waiting.label).toBe("Stopping Codespace");
    expect(waiting.description).toContain("Waiting for GitHub to confirm");

    const complete = codespacesOperationPresentation({
      ...stopping,
      status: "succeeded",
      stage: "complete",
    });
    expect(complete.tone).toBe("success");
    expect(complete.label).toBe("Codespace stopped");
    expect(complete.description).toContain("Storage usage continues");
  });

  it("preserves the recovery message when shutdown cannot be confirmed", () => {
    const message = "GitHub has not confirmed shutdown yet. Refresh its status before retrying.";
    const result = codespacesOperationPresentation({ ...stopping, status: "failed", message });
    expect(result.tone).toBe("error");
    expect(result.label).toBe("Codespace needs attention");
    expect(result.description).toBe(message);
  });

  it("does not announce readiness while creation or SSH setup is running", () => {
    const creating = codespacesOperationPresentation({
      ...stopping,
      action: "create",
      stage: "creating",
    });
    const connecting = codespacesOperationPresentation({
      ...stopping,
      action: "create",
      stage: "bootstrapping",
    });
    expect(creating.tone).toBe("info");
    expect(creating.description).toContain("GitHub");
    expect(connecting.label).toBe("Connecting workspace");
    expect(connecting.tone).toBe("info");
    expect(connecting.description).toContain("SSH");
  });

  it("preserves server feedback for a newly introduced stage", () => {
    const message = "Waiting for the repository to finish cloning.";
    const result = codespacesOperationPresentation({
      ...stopping,
      action: "create",
      stage: "cloning",
      message,
    });
    expect(result.label).toBe("Creating Codespace");
    expect(result.description).toBe(message);
    expect(result.tone).toBe("info");
  });

  it("shows deletion as completed only after success and explains history retention", () => {
    expect(
      codespacesOperationPresentation({ ...stopping, action: "delete", stage: "deleting" }).label,
    ).toBe("Deleting Codespace");
    const deleted = codespacesOperationPresentation({
      ...stopping,
      action: "delete",
      status: "succeeded",
    });
    expect(deleted.label).toBe("Codespace deleted");
    expect(deleted.description).toContain("local thread history remains");
  });
});

describe("GitHub workspace state", () => {
  it("distinguishes available compute from a stopped or missing workspace", () => {
    expect(codespaceStateLabel("Available")).toBe("Running");
    expect(codespaceStateLabel("Shutdown")).toBe("Stopped");
    expect(codespaceStateLabel(undefined)).toBe("Disconnected");
  });

  it("preserves unfamiliar GitHub states rather than calling them disconnected", () => {
    expect(codespaceStateLabel("Awaiting")).toBe("Awaiting");
  });
});

it("preserves the draft and does not duplicate Codespaces setup instructions", () => {
  const prompt = codespacesSetupPrompt("Fix the tests first.");
  expect(prompt).toContain(
    "Fix the tests first.\n\nMake this project compatible with GitHub Codespaces.",
  );
  expect(prompt).toContain(".devcontainer/devcontainer.json");
  expect(codespacesSetupPrompt(prompt)).toBe(prompt);
});
