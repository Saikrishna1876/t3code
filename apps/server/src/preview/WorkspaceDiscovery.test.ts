import { expect, it } from "@effect/vitest";
import {
  CodespacesError,
  ProjectId,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewStopLocalServerInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Workspace from "../codespaces/CodespacesWorkspace.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ProjectionStore.ts";
import * as PortScanner from "./PortScanner.ts";
import * as Discovery from "./WorkspaceDiscovery.ts";

const threadId = ThreadId.make("discovery-thread");
const projectId = ProjectId.make("project:mcp-test");
const project = Schema.decodeSync(Projects.ProjectRow)({
  projectId,
  title: "Project",
  workspaceRoot: "/local/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
  deletedAt: null,
});
const servers: ReadonlyArray<DiscoveredLocalServer> = [
  {
    host: "127.0.0.1",
    port: 3000,
    url: "http://127.0.0.1:3000/",
    processName: "node",
    pid: 123,
    processStartTime: "100",
    terminal: null,
    agent: null,
  },
];
const stopInput: PreviewStopLocalServerInput = {
  threadId,
  pid: 123,
  port: 3000,
  processStartTime: "100",
};

function fixture(input: {
  readonly codespaceName: string | null;
  readonly worktreePath?: string;
  readonly disconnected?: boolean;
}) {
  const remoteCalls: Array<{
    cwd: string;
    group: string;
    method: string;
    args: ReadonlyArray<unknown>;
  }> = [];
  const localScans: ReadonlyArray<string>[] = [];
  const localStops: PreviewStopLocalServerInput[] = [];
  let retained = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(Projects.ProjectStoreV2)({ get: () => Effect.succeedSome(project) }),
    Layer.mock(Threads.ProjectionStoreV2)({
      getThreadShell: () =>
        Effect.succeed({
          ...liveThreadShell(threadId),
          codespaceName: input.codespaceName,
          worktreePath: input.worktreePath ?? null,
        }),
    }),
    Layer.mock(Workspace.CodespacesWorkspace)({
      call: <A>(cwd: string, group: string, method: string, args: ReadonlyArray<unknown>) =>
        Effect.gen(function* () {
          remoteCalls.push({ cwd, group, method, args });
          if (input.disconnected)
            return yield* new CodespacesError({ code: "conflict", message: "Disconnected" });
          return (method === "scan" ? { servers } : undefined) as A;
        }),
    }),
    Layer.mock(PortScanner.PortDiscovery)({
      trackAgent: () => () => undefined,
      retain: Effect.sync(() => {
        retained++;
      }),
      scan: (urls) =>
        Effect.sync(() => {
          localScans.push(urls ?? []);
          return servers;
        }),
      subscribe: () => Effect.void,
      stopServer: (request) =>
        Effect.sync(() => {
          localStops.push(request);
        }),
    }),
  );
  return {
    layer: Discovery.layer.pipe(Layer.provide(dependencies)),
    remoteCalls,
    localScans,
    localStops,
    retained: () => retained,
  };
}

it.effect(
  "routes remote discovery and stop to the selected checkout without claiming configured URL probing",
  () =>
    Effect.gen(function* () {
      for (const worktreePath of [undefined, "/local/repo/.git/t3-codespaces/cloud/tree"]) {
        const test = fixture({ codespaceName: "cloud", ...(worktreePath ? { worktreePath } : {}) });
        yield* Effect.gen(function* () {
          const discovery = yield* Discovery.WorkspaceDiscovery;
          const snapshot = yield* discovery
            .stream({ threadId, configuredUrls: ["https://localhost:3000/app"] })
            .pipe(Stream.runHead);
          expect(Option.getOrThrow(snapshot)).toMatchObject({ servers, codespaceName: "cloud" });
          expect(Option.getOrThrow(snapshot).configuredUrlProbing).toBeUndefined();
          yield* discovery.stop(stopInput);
          const cwd = worktreePath ?? "/local/repo/.git/t3-codespaces/cloud";
          expect(test.remoteCalls).toEqual([
            { cwd, group: "telemetry", method: "scan", args: [{ cwd, threadId }] },
            { cwd, group: "telemetry", method: "stop", args: [{ ...stopInput, cwd }] },
          ]);
          expect(test.localScans).toEqual([]);
          expect(test.localStops).toEqual([]);
          expect(test.retained()).toBe(0);
        }).pipe(Effect.provide(test.layer));
      }
    }),
);

it.effect(
  "reports disconnected remote discovery and refuses stop without touching host processes",
  () => {
    const test = fixture({ codespaceName: "cloud", disconnected: true });
    return Effect.gen(function* () {
      const discovery = yield* Discovery.WorkspaceDiscovery;
      const snapshot = yield* discovery.stream({ threadId }).pipe(Stream.runHead);
      expect(Option.getOrThrow(snapshot)).toMatchObject({
        servers: [],
        codespaceName: "cloud",
        error: "disconnected",
      });
      expect((yield* discovery.stop(stopInput).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.localScans).toEqual([]);
      expect(test.localStops).toEqual([]);
      expect(test.retained()).toBe(0);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("keeps host discovery and stop on the local scanner", () => {
  const test = fixture({ codespaceName: null });
  return Effect.gen(function* () {
    const discovery = yield* Discovery.WorkspaceDiscovery;
    const configuredUrls = ["https://localhost:3000/app"];
    const snapshot = yield* discovery.stream({ threadId, configuredUrls }).pipe(Stream.runHead);
    expect(Option.getOrThrow(snapshot)).toMatchObject({ servers, configuredUrlProbing: true });
    expect(Option.getOrThrow(snapshot).codespaceName).toBeUndefined();
    yield* discovery.stop(stopInput);
    expect(test.localScans).toEqual([configuredUrls]);
    expect(test.localStops).toEqual([stopInput]);
    expect(test.retained()).toBe(1);
    expect(test.remoteCalls).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});
