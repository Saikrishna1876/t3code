import "~/index.css";

import {
  EnvironmentId,
  ProjectId,
  type CodespacesConfiguration,
  type CodespacesSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

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

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () =>
    ({
      serverConfig: { environment: { capabilities: { codespaces: true } } },
    }) as never,
}));
vi.mock(import("~/state/codespaces"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...(await original()),
    codespacesEnvironment: {
      authorize: { permissionAtom: () => allowed },
      run: { permissionAtom: () => allowed },
      project: () => "project",
      state: () => "state",
      list: () => "list",
      configure: "configure",
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: string) =>
    command === "configure" ? state.configure : vi.fn()) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((kind: string) => ({
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
  })) as never,
}));

import { ProjectCodespacesControl } from "./ProjectCodespacesControl";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const view = () => (
  <ProjectCodespacesControl
    environmentId={EnvironmentId.make("local")}
    projectId={ProjectId.make("project")}
  />
);
const switchControl = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="switch"]')!;
const openAccess = async (container: HTMLElement) => {
  const details = [...container.querySelectorAll("details")].find((entry) =>
    entry.querySelector("summary")?.textContent?.includes("Requirements"),
  )!;
  await act(async () => details.querySelector("summary")!.click());
  return details;
};

function setup() {
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
}

it("keeps the optimistic toggle through a delayed subscription update without global progress", async () => {
  setup();
  const save = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(save.promise);
  await using screen = await render(view());
  const container = screen.container;
  const details = await openAccess(container);
  const status = details.querySelector('[role="status"]');
  await act(async () => switchControl(container).click());
  expect(switchControl(container).getAttribute("aria-checked")).toBe("true");
  expect(switchControl(container).matches('[aria-disabled="true"]')).toBe(true);
  await act(async () => switchControl(container).click());
  expect(state.configure).toHaveBeenCalledTimes(1);
  expect(status?.textContent).toBe("Saving…");
  expect(container.textContent).not.toContain("Saving agent access");
  expect(container.textContent).not.toContain("Work continues on your T3 host");
  const saved = {
    ...state.snapshot!,
    configuration: { ...state.snapshot!.configuration, agentAccessEnabled: true },
  };
  await act(async () => save.resolve(AsyncResult.success(saved)));
  expect(switchControl(container).getAttribute("aria-checked")).toBe("true");
  expect(switchControl(container).matches('[aria-disabled="true"]')).toBe(false);
  expect(details.querySelector('[role="status"]')).toBe(status);
  state.snapshot = saved;
  await screen.rerender(view());
  state.snapshot = {
    ...saved,
    configuration: { ...saved.configuration, agentAccessEnabled: false },
  };
  await screen.rerender(view());
  expect(switchControl(container).getAttribute("aria-checked")).toBe("false");
});

it("rolls back a failed save, reports it beside the switch, and allows retry", async () => {
  setup();
  const save = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(save.promise);
  await using screen = await render(view());
  const container = screen.container;
  const details = await openAccess(container);
  await act(async () => switchControl(container).click());
  await act(async () =>
    save.resolve(AsyncResult.failure(Cause.fail(new Error("Permission denied")))),
  );
  expect(switchControl(container).getAttribute("aria-checked")).toBe("false");
  expect(switchControl(container).matches('[aria-disabled="true"]')).toBe(false);
  expect(details.querySelector('[role="status"]')?.textContent).toBe("Permission denied");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const retry = deferred<AsyncResult.AsyncResult<CodespacesSnapshot, Error>>();
  state.configure.mockReturnValue(retry.promise);
  await act(async () => switchControl(container).click());
  expect(switchControl(container).getAttribute("aria-checked")).toBe("true");
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
  setup();
  state.eligible = false;
  await using screen = await render(view());
  const container = screen.container;
  expect(container.textContent).toContain("Choose Codespace under Run on");
  expect(container.textContent).not.toContain("Create a Codespace for this project");
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("New Codespace"),
    ),
  ).toBe(false);
});
