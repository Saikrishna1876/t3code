import { WS_METHODS } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { ConnectionOnboarding } from "../connection/onboarding.ts";
import * as Crypto from "effect/Crypto";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCodespacesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ConnectionOnboarding | Crypto.Crypto | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "codespaces:state",
    tag: WS_METHODS.codespacesSubscribe,
  });
  const refreshes = Atom.family((environmentId: EnvironmentId) => {
    const seen = new WeakMap<object, { signature: string; revision: number }>();
    return Atom.make((get) => {
      const snapshot = Option.getOrUndefined(
        AsyncResult.value(get(state({ environmentId, input: undefined }))),
      );
      const previous = seen.get(get.registry);
      if (!snapshot) return previous?.revision ?? 0;
      const signature = JSON.stringify([
        snapshot.bindingRevision ?? 0,
        snapshot.operations.map(({ clientRequestId, projectId, name, status }) => [
          clientRequestId,
          projectId,
          name,
          status,
        ]),
        snapshot.environments.map(({ name, connected }) => [name, connected]),
      ]);
      // The first snapshot is a baseline, not a mutation that needs another inventory read.
      const revision = previous ? previous.revision + Number(previous.signature !== signature) : 0;
      seen.set(get.registry, { signature, revision });
      return revision;
    });
  });
  return {
    project: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codespaces:project",
      tag: WS_METHODS.codespacesProject,
      staleTimeMs: 2000,
      refreshTrigger: ({ environmentId }) => refreshes(environmentId),
    }),
    bind: createEnvironmentRpcCommand(runtime, {
      label: "codespaces:bind",
      tag: WS_METHODS.codespacesBind,
    }),
    state,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codespaces:list",
      tag: WS_METHODS.codespacesList,
      staleTimeMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes(environmentId),
    }),
    options: createEnvironmentRpcCommand(runtime, {
      label: "codespaces:options",
      tag: WS_METHODS.codespacesOptions,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "codespaces:configure",
      tag: WS_METHODS.codespacesConfigure,
    }),
    run: createEnvironmentRpcCommand(runtime, {
      label: "codespaces:run",
      tag: WS_METHODS.codespacesRun,
    }),
    pair: createEnvironmentRpcCommand(runtime, {
      label: "codespaces:pair",
      tag: WS_METHODS.codespacesPair,
    }),
  };
}
