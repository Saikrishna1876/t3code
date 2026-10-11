import { createCodespacesEnvironmentAtoms } from "@t3tools/client-runtime/state/codespaces";
import { connectionAtomRuntime } from "../connection/runtime";

export const codespacesEnvironment = createCodespacesEnvironmentAtoms(connectionAtomRuntime);
