import { buildWorkspaceWorker } from "./build-workspace-worker.ts";

await buildWorkspaceWorker();
const { runCliCommand } = await import("../src/binMain.ts");
await runCliCommand();
