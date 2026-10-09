import { build } from "vite-plus/pack";
import * as NodeURL from "node:url";
await build({
  entry: [NodeURL.fileURLToPath(new URL("../src/codespaces/worker.ts", import.meta.url))],
  outDir: NodeURL.fileURLToPath(new URL("../dist-workspace", import.meta.url)),
  config: false,
  platform: "node",
  target: "node22",
  minify: true,
  deps: { alwaysBundle: () => true, onlyBundle: false },
  define: { __T3CODE_BUILD_RELAY_URL__: '""', __T3CODE_BUILD_CHANNEL__: '"latest"' },
});
