import { describe, expect, it } from "vite-plus/test";

import {
  fillNewTaskWorkspaceBranch,
  resolveNewTaskBranchLabel,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskLocalWorkspaceSelection,
  resolveNewTaskWorkspaceSelection,
} from "./new-task-context-presentation";

describe("resolveNewTaskWorkspaceSelection", () => {
  const fallback = { mode: "worktree", branch: null, worktreePath: null } as const;

  it("falls back to the current checkout when a non-git project defaults to worktree", () => {
    expect(
      resolveNewTaskWorkspaceSelection({
        canChooseWorkspace: true,
        selection: undefined,
        fallback,
        isGitRepo: false,
      }),
    ).toEqual({ mode: "local", branch: null, worktreePath: null });
  });

  it.each(["local", "worktree"] as const)(
    "clears stale %s selections for non-git projects",
    (mode) => {
      expect(
        resolveNewTaskWorkspaceSelection({
          canChooseWorkspace: true,
          selection: {
            mode,
            branch: "main",
            worktreePath: "/old-worktree",
            startFromOrigin: true,
            pullRequestReference: "https://github.com/acme/repo/pull/123",
          },
          fallback,
          isGitRepo: false,
        }),
      ).toEqual({ mode: "local", branch: null, worktreePath: null });
    },
  );

  // regression: #21404 use current checkout for non-git projects
  it("preserves the selection and defaults for git projects", () => {
    const selection = { mode: "local", branch: "feature", worktreePath: "/worktree" } as const;
    expect(
      resolveNewTaskWorkspaceSelection({
        canChooseWorkspace: true,
        selection,
        fallback,
        isGitRepo: true,
      }),
    ).toBe(selection);
    expect(
      resolveNewTaskWorkspaceSelection({
        canChooseWorkspace: true,
        selection: undefined,
        fallback,
        isGitRepo: true,
      }),
    ).toBe(fallback);
  });
});

describe("resolveNewTaskBranchLabel", () => {
  it.each([
    ["https://github.com/acme/repo/pull/123", "From PR #123"],
    ["https://gitlab.com/acme/repo/-/merge_requests/123", "From MR #123"],
  ])("names the change request a worktree starts from (%s)", (pullRequestReference, label) => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: null,
        startFromOrigin: false,
        workspaceMode: "worktree",
        pullRequestReference,
      }),
    ).toBe(label);
  });
});

describe("resolveNewTaskLocalWorkspaceSelection", () => {
  it("waits for refs instead of carrying a worktree base into Current checkout", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    });
  });

  it("carries the worktree path when the current branch lives in another worktree", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [
          { name: "feature/split", current: true, worktreePath: "/repo/.t3/worktrees/split" },
          { name: "main", current: false, worktreePath: "/repo" },
        ],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: "feature/split",
      worktreePath: "/repo/.t3/worktrees/split",
      awaitsCurrentBranch: false,
    });
  });
});

describe("resolveNewTaskBranchWorktreePath", () => {
  it("does not reuse an existing worktree while creating a new one", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "worktree",
        projectCwd: "/repo",
        branchWorktreePath: "/repo/.t3/worktrees/feature",
      }),
    ).toBeNull();
  });
});

describe("Codespace task workspace selection", () => {
  it("uses the main checkout despite a worktree default", () => {
    expect(
      resolveNewTaskWorkspaceSelection({
        canChooseWorkspace: false,
        fallback: { mode: "worktree", branch: null, worktreePath: null },
        isGitRepo: true,
      }),
    ).toEqual({ mode: "local", branch: null, worktreePath: null, startFromOrigin: false });
  });

  it.each(["local", "worktree"] as const)(
    "ignores saved %s worktree selections while bound",
    (mode) => {
      expect(
        resolveNewTaskWorkspaceSelection({
          canChooseWorkspace: false,
          fallback: { mode: "worktree", branch: null, worktreePath: null },
          isGitRepo: true,
          selection: {
            mode,
            branch: "feature",
            worktreePath: "/repo/worktrees/feature",
            startFromOrigin: true,
          },
        }),
      ).toEqual({ mode: "local", branch: null, worktreePath: null, startFromOrigin: false });
    },
  );

  it("restores the saved selection after returning to local work", () => {
    const selection = {
      mode: "worktree" as const,
      branch: "feature",
      worktreePath: "/repo/worktrees/feature",
      startFromOrigin: true,
    };
    expect(
      resolveNewTaskWorkspaceSelection({
        canChooseWorkspace: true,
        fallback: { mode: "local", branch: null, worktreePath: null },
        isGitRepo: true,
        selection,
      }),
    ).toEqual(selection);
  });
});

it.each([true, false])(
  "keeps PR worktree references only when workspace selection is allowed: %s",
  (canChooseWorkspace) => {
    const reference = "https://github.com/acme/repo/pull/123";
    const workspace = resolveNewTaskWorkspaceSelection({
      canChooseWorkspace,
      fallback: { mode: "worktree", branch: null, worktreePath: null },
      isGitRepo: true,
      selection: {
        mode: "worktree",
        branch: null,
        worktreePath: null,
        pullRequestReference: reference,
      },
    });
    expect(workspace.mode).toBe(canChooseWorkspace ? "worktree" : "local");
    expect(workspace.pullRequestReference).toBe(canChooseWorkspace ? reference : undefined);
  },
);
describe("fillNewTaskWorkspaceBranch", () => {
  const branches = [
    { name: "origin/main", current: false, isDefault: true, isRemote: true },
    { name: "feature", current: true, isDefault: false, worktreePath: "/repo-feature" },
  ];
  const base = {
    branches,
    projectCwd: "/repo",
    worktreeDefaultSettled: true,
  };

  it("bases a new worktree on the default branch, even when only the remote has it", () => {
    expect(
      fillNewTaskWorkspaceBranch({
        ...base,
        selection: { mode: "worktree", branch: null, worktreePath: null },
      }),
    ).toEqual({ mode: "worktree", branch: "origin/main", worktreePath: null });
  });

  it("waits for the workspace default to settle before picking a base", () => {
    const selection = { mode: "worktree", branch: null, worktreePath: null } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, selection, worktreeDefaultSettled: false })).toBe(
      selection,
    );
  });

  it("follows the current checkout only for a local selection the user just chose", () => {
    const selection = { mode: "local", branch: null, worktreePath: null } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, selection })).toBe(selection);
    expect(
      fillNewTaskWorkspaceBranch({
        ...base,
        selection: { ...selection, followsCurrentCheckout: true },
      }),
    ).toEqual({
      mode: "local",
      branch: "feature",
      worktreePath: "/repo-feature",
      followsCurrentCheckout: true,
    });
  });

  it("fills the current branch once refs arrive after local mode was chosen", () => {
    const selection = {
      mode: "local",
      branch: null,
      worktreePath: null,
      followsCurrentCheckout: true,
    } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, branches: [], selection })).toBe(selection);
    expect(fillNewTaskWorkspaceBranch({ ...base, selection })).toMatchObject({
      branch: "feature",
      worktreePath: "/repo-feature",
    });
  });

  it("keeps an explicit branch", () => {
    const selection = { mode: "worktree", branch: "release", worktreePath: null } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, selection })).toBe(selection);
  });
});
