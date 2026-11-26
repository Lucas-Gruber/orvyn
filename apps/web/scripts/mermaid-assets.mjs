import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(
  new URL("../app/generated/mermaid/", import.meta.url),
);
await mkdir(destination, { recursive: true });
await build({
  entryPoints: [
    fileURLToPath(new URL("../diagram/renderer.ts", import.meta.url)),
  ],
  outfile: destination + "/renderer.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "inline",
  logLevel: "warning",
});
