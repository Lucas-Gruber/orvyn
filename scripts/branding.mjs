import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const dir of ["branding/desktop", "apps/web/public/branding"])
  await mkdir(resolve(root, dir), { recursive: true });
function convert(...args) {
  const result = spawnSync("magick", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0)
    throw Error("ImageMagick 7 is required to export icons");
}
// Packaging only: the generated transparent masters remain unchanged in source/.
for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) {
  convert(
    "branding/source/icon.png",
    "-resize",
    `${size}x${size}`,
    "-strip",
    `branding/desktop/icon-${size}.png`,
  );
}
convert(
  "branding/desktop/icon-256.png",
  "-define",
  "icon:auto-resize=256,128,64,48,32,16",
  "branding/desktop/icon.ico",
);
const entries = [];
for (const [type, size] of [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
]) {
  const data = await readFile(
    resolve(root, `branding/desktop/icon-${size}.png`),
  );
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(data.length + 8, 4);
  entries.push(header, data);
}
const payload = Buffer.concat(entries),
  header = Buffer.alloc(8);
header.write("icns");
header.writeUInt32BE(payload.length + 8, 4);
await writeFile(
  resolve(root, "branding/desktop/icon.icns"),
  Buffer.concat([header, payload]),
);
for (const [source, target] of [
  ["branding/desktop/icon-32.png", "apps/web/public/branding/favicon-32.png"],
  [
    "branding/desktop/icon-180.png",
    "apps/web/public/branding/apple-touch-icon.png",
  ],
  ["branding/desktop/icon-192.png", "apps/web/public/branding/icon-192.png"],
  ["branding/desktop/icon-512.png", "apps/web/public/branding/icon-512.png"],
  ["branding/desktop/icon-512.png", "infrastructure/helm/orvyn/icon.png"],
  ["branding/desktop/icon.ico", "apps/web/public/favicon.ico"],
])
  await copyFile(resolve(root, source), resolve(root, target));
console.log("Exported PNG, Windows ICO, macOS ICNS, web and Helm icons");
