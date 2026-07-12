import { build as bundleServer } from "esbuild";
import { build as buildFrontend } from "vite";

await buildFrontend();
await bundleServer({
  entryPoints: ["server/bootstrap.ts"],
  outfile: "dist-server/server.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: false,
  legalComments: "none",
});

console.log("Production server bundle: dist-server/server.mjs");
