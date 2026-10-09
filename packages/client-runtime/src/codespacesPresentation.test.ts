import { describe, expect, it } from "vite-plus/test";
import type { CodespacesOperation } from "@t3tools/contracts";
import { codespacesOperationPresentation, codespaceStateLabel } from "./codespacesPresentation.ts";

const stopping: CodespacesOperation = {
  clientRequestId: "test-stop-request",
  action: "stop",
  name: "test-workspace",
  status: "running",
  stage: "stopping",
  message: "Requesting stop from GitHub.",
  createdAt: "2026-10-09T10:00:00.000Z",
};

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
