import { build as bundleServer } from "esbuild";
import { build as buildFrontend } from "vite";

await buildFrontend();
await bundleServer({
  entryPoints: {
    server: "server/bootstrap.ts",
    "sync-salla-products": "scripts/sync-salla-products.ts",
  },
  outdir: "dist-server",
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: false,
  legalComments: "none",
});

console.log("Production bundles: dist-server/server.mjs, dist-server/sync-salla-products.mjs");
