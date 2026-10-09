// @vitest-environment jsdom

import {
  EnvironmentId,
  ProjectId,
  type CodespacesConfiguration,
  type CodespacesSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  eligible: true,
  snapshot: null as CodespacesSnapshot | null,
  configure:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: CodespacesConfiguration;
      }) => Promise<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>
    >(),
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: { environment: { capabilities: { codespaces: true } } },
  }),
}));
vi.mock("~/state/codespaces", () => ({
  codespacesEnvironment: {
    run: { permissionAtom: () => Atom.make(true) },
    project: () => "project",
    state: () => "state",
    list: () => "list",
    configure: "configure",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "configure" ? state.configure : vi.fn()),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (kind: string) => ({
    data:
      kind === "project"
        ? {
            eligible: state.eligible,
            reason: "Add a .devcontainer/devcontainer.json to this project first.",
            repository: "owner/repo",
            ref: "main",
            devcontainerPaths: state.eligible ? [".devcontainer/devcontainer.json"] : [],
            name: null,
            connected: false,
          }
        : kind === "state"
          ? state.snapshot
          : { codespaces: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

import { ProjectCodespacesControl } from "./ProjectCodespacesControl";

let container: HTMLDivElement;
let root: Root;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const render = () =>
  act(async () => {
    root.render(
      <ProjectCodespacesControl
        environmentId={EnvironmentId.make("local")}
        projectId={ProjectId.make("project")}
      />,
    );
  });
const switchControl = () => container.querySelector<HTMLElement>('[role="switch"]')!;
const openAccess = async () => {
  const details = [...container.querySelectorAll("details")].find((entry) =>
    entry.querySelector("summary")?.textContent?.includes("Requirements"),
  )!;
  await act(async () => details.querySelector("summary")!.click());
  return details;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.configure.mockReset();
  state.eligible = true;
  state.snapshot = {
    configuration: {
      releaseBaseUrl: "",
      archiveVersion: "",
      remoteScriptPath: "",
      publicUrlTemplate: "",
      networkAccess: false,
      agentAccessEnabled: false,
    },
    operations: [],
    environments: [],
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps the optimistic toggle through a delayed subscription update without global progress", async () => {
  const save = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(save.promise);
  await render();
  const details = await openAccess();
  const status = details.querySelector('[role="status"]');
  await act(async () => switchControl().click());
  expect(switchControl().getAttribute("aria-checked")).toBe("true");
  expect(switchControl().matches('[aria-disabled="true"]')).toBe(true);
  await act(async () => switchControl().click());
  expect(state.configure).toHaveBeenCalledTimes(1);
  expect(status?.textContent).toBe("Saving…");
  expect(container.textContent).not.toContain("Saving agent access");
  expect(container.textContent).not.toContain("Work continues on your T3 host");
  const saved = {
    ...state.snapshot!,
    configuration: { ...state.snapshot!.configuration, agentAccessEnabled: true },
  };
  await act(async () => save.resolve(AsyncResult.success(saved)));
  expect(switchControl().getAttribute("aria-checked")).toBe("true");
  expect(switchControl().matches('[aria-disabled="true"]')).toBe(false);
  expect(details.querySelector('[role="status"]')).toBe(status);
  state.snapshot = saved;
  await render();
  state.snapshot = {
    ...saved,
    configuration: { ...saved.configuration, agentAccessEnabled: false },
  };
  await render();
  expect(switchControl().getAttribute("aria-checked")).toBe("false");
});

it("rolls back a failed save, reports it beside the switch, and allows retry", async () => {
  const save = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(save.promise);
  await render();
  const details = await openAccess();
  await act(async () => switchControl().click());
  await act(async () =>
    save.resolve(AsyncResult.failure(Cause.fail(new Error("Permission denied")))),
  );
  expect(switchControl().getAttribute("aria-checked")).toBe("false");
  expect(switchControl().matches('[aria-disabled="true"]')).toBe(false);
  expect(details.querySelector('[role="status"]')?.textContent).toBe("Permission denied");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const retry = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(retry.promise);
  await act(async () => switchControl().click());
  expect(switchControl().getAttribute("aria-checked")).toBe("true");
  expect(state.configure).toHaveBeenCalledTimes(2);
  await act(async () =>
    retry.resolve(
      AsyncResult.success({
        ...state.snapshot!,
        configuration: { ...state.snapshot!.configuration, agentAccessEnabled: true },
      }),
    ),
  );
});

it("directs incompatible projects to setup instead of an unusable creation button", async () => {
  state.eligible = false;
  await render();
  expect(container.textContent).toContain("Choose Codespace under Run on");
  expect(container.textContent).not.toContain("Create a Codespace for this project");
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("New Codespace"),
    ),
  ).toBe(false);
});
