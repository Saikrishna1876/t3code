import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type CodespacesSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { ConnectionOnboarding } from "../connection/onboarding.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import type {
  SupervisorConnectionState,
  PreparedConnection,
  NetworkStatus,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createCodespacesEnvironmentAtoms } from "./codespaces.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
vi.mock("../rpc/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/client.ts")>()),
  request: (tag: string, input: unknown) => mocks.request(tag, input),
  subscribe: (tag: string) => mocks.subscribe(tag),
}));

describe("Codespaces project status", () => {
  it.effect("paired clients observe changes without lifecycle access", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("codespaces-host");
      const projectId = ProjectId.make("project");
      const snapshot: CodespacesSnapshot = {
        configuration: {
          releaseBaseUrl: "",
          archiveVersion: "",
          remoteScriptPath: "",
          publicUrlTemplate: "",
          networkAccess: false,
          agentAccessEnabled: false,
        },
        environments: [],
        operations: [
          {
            clientRequestId: "connect",
            projectId,
            action: "connect",
            name: "space",
            status: "running",
            stage: "starting",
            message: "Starting",
            createdAt: "2026-10-10T00:00:00.000Z",
          },
        ],
      };
      const state = yield* SubscriptionRef.make(snapshot);
      const reads = yield* Queue.unbounded<boolean>();
      let connected = false;
      mocks.subscribe.mockImplementation((tag: string) => {
        expect(tag).toBe(WS_METHODS.codespacesSubscribe);
        return SubscriptionRef.changes(state);
      });
      mocks.request.mockImplementation((tag: string) => {
        expect(tag).toBe(WS_METHODS.codespacesProject);
        return Queue.offer(reads, connected).pipe(
          Effect.as({
            projectId,
            eligible: true,
            reason: "",
            repository: "example/project",
            ref: "main",
            devcontainerPaths: [".devcontainer/devcontainer.json"],
            name: connected ? "space" : null,
            connected,
          }),
        );
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Host",
          httpBaseUrl: "http://localhost:3773",
          wsBaseUrl: "ws://localhost:3773",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environmentRegistry = Layer.mock(EnvironmentRegistry)({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        run: (_id, effect) =>
          effect.pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
        followStream: (_id, stream) =>
          stream.pipe(
            Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      });
      const runtime = Atom.runtime(
        Layer.mergeAll(
          environmentRegistry,
          Layer.mock(ConnectionOnboarding)({}),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: () => Effect.die("Unexpected digest"),
            }),
          ),
        ),
      );
      const atoms = createCodespacesEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.set(
        sessions(environmentId),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [...AuthStandardClientScopes],
          permissions: [...AuthStandardClientScopes],
        }),
      );
      expect(registry.get(atoms.run.permissionAtom(environmentId))).toBe(false);
      const project = atoms.project({ environmentId, input: { projectId } });
      registry.mount(project);
      yield* AtomRegistry.getResult(registry, atoms.state({ environmentId, input: undefined }));
      expect(
        (yield* AtomRegistry.getResult(registry, project, { suspendOnWaiting: true })).connected,
      ).toBe(false);
      expect(yield* Queue.takeAll(reads)).toEqual([false]);
      connected = true;
      yield* SubscriptionRef.set(state, {
        ...snapshot,
        operations: snapshot.operations.map((operation) => ({
          ...operation,
          status: "succeeded" as const,
          stage: "complete",
        })),
      });
      expect(yield* Queue.take(reads)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, project, { suspendOnWaiting: true })).connected,
      ).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, project, { suspendOnWaiting: true })).name,
      ).toBe("space");
      connected = false;
      yield* SubscriptionRef.update(state, (current) => ({ ...current, bindingRevision: 1 }));
      expect(yield* Queue.take(reads)).toBe(false);
      const local = yield* AtomRegistry.getResult(registry, project, { suspendOnWaiting: true });
      expect(local.name).toBeNull();
      expect(local.connected).toBe(false);
    }),
  );
});
