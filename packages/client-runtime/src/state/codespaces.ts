import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
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
  return {
    project: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codespaces:project",
      tag: WS_METHODS.codespacesProject,
      staleTimeMs: 2000,
    }),
    bind: createEnvironmentRpcCommand(runtime, {
      label: "codespaces:bind",
      tag: WS_METHODS.codespacesBind,
    }),
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "codespaces:state",
      tag: WS_METHODS.codespacesSubscribe,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codespaces:list",
      tag: WS_METHODS.codespacesList,
      staleTimeMs: 10_000,
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
