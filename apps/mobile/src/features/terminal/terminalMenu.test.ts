import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";

import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import {
  nextOpenTerminalId,
  pickTerminalIdForBootstrap,
  previousLiveTerminalId,
  resolveProjectScriptTerminalId,
  type TerminalMenuSession,
} from "./terminalMenu";

function makeMenuSession(input: {
  readonly terminalId: string;
  readonly status: TerminalMenuSession["status"];
}): TerminalMenuSession {
  return {
    terminalId: input.terminalId,
    cwd: null,
    status: input.status,
    hasRunningSubprocess: false,
    displayLabel: getTerminalLabel(input.terminalId),
    updatedAt: null,
  };
}

describe("nextOpenTerminalId", () => {
  it("allocates separate terminals on repeated visits without readable metadata", () => {
    const first = nextOpenTerminalId({
      listedTerminalIds: [],
      uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40",
    });
    const nextVisit = nextOpenTerminalId({
      listedTerminalIds: [],
      uniqueSuffix: "102315fc-ceef-45c4-b978-c4d4947d3c26",
    });
    expect(first).not.toBe(DEFAULT_TERMINAL_ID);
    expect(nextVisit).not.toBe(first);
  });

  it("avoids the mounted primary tab when the session list is still empty", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });
});

describe("previousLiveTerminalId", () => {
  it("prefers the nearest live session below the exited id", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "running" }),
          makeMenuSession({ terminalId: "term-2", status: "running" }),
          makeMenuSession({ terminalId: "term-3", status: "exited" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: "term-3",
      }),
    ).toBe("term-2");
  });

  it("falls back to the nearest live session above when the exited id was lowest", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "exited" }),
          makeMenuSession({ terminalId: "term-2", status: "starting" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });
});

describe("resolveProjectScriptTerminalId", () => {
  it("never targets an unseen default terminal when metadata is unavailable", () => {
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: [],
      hasRunningTerminal: false,
      uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40",
    });
    expect(terminalId).not.toBe(DEFAULT_TERMINAL_ID);
  });
});

it("bootstraps on the selected computer while retaining terminals on other computers", () => {
  const remoteRoot = "/repo/.git/t3-codespaces/cloud";
  const session = (terminalId: string, cwd: string): KnownTerminalSession => ({
    target: {
      environmentId: EnvironmentId.make("host"),
      threadId: ThreadId.make("thread"),
      terminalId,
    },
    state: {
      ...EMPTY_TERMINAL_SESSION_STATE,
      status: "running",
      summary: {
        threadId: ThreadId.make("thread"),
        terminalId,
        cwd,
        worktreePath: null,
        status: "running",
        pid: 123,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: terminalId,
        updatedAt: "2026-11-06T00:00:00.000Z",
      },
    },
  });
  const host = session("term-1", "/repo");
  const remote = session("term-3", remoteRoot);
  expect(
    pickTerminalIdForBootstrap({ sessions: [host], workspaceRoot: remoteRoot, canOperate: false }),
  ).toBeNull();
  expect(
    pickTerminalIdForBootstrap({ sessions: [host], workspaceRoot: remoteRoot, canOperate: true }),
  ).toBe("term-2");
  expect(
    pickTerminalIdForBootstrap({
      sessions: [host, remote],
      workspaceRoot: remoteRoot,
      canOperate: true,
    }),
  ).toBe("term-3");
  expect(
    pickTerminalIdForBootstrap({
      sessions: [host, remote],
      workspaceRoot: "/repo",
      canOperate: true,
    }),
  ).toBe("term-1");
  expect(
    pickTerminalIdForBootstrap({
      sessions: [host, remote],
      workspaceRoot: remoteRoot,
      canOperate: false,
    }),
  ).toBe("term-3");
});
