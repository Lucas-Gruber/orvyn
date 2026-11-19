import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const source = dirname(
  fileURLToPath(import.meta.resolve("@excalidraw/excalidraw")),
);
const destination = fileURLToPath(
  new URL("../public/excalidraw-assets/", import.meta.url),
);
await mkdir(destination, { recursive: true });
// Excalidraw marks Liberation as a server-side font. The browser adapter
// uses its client font families for drawing and exports.
await rm(join(destination, "fonts", "Liberation"), {
  recursive: true,
  force: true,
});
await cp(join(source, "fonts"), join(destination, "fonts"), {
  recursive: true,
  filter: (path) => basename(path) !== "Liberation",
});
