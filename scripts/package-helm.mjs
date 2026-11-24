import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { helmImage } from "./helm-tools.mjs";
import { checkVersions, root } from "./release.mjs";
const run = promisify(execFile);
const { version } = await checkVersions();
const commit = (
  await run("git", ["rev-parse", "HEAD"], { cwd: root })
).stdout.trim();
const destination = resolve(root, process.argv[2] || ".local/helm-package");
const temp = await mkdtemp(join(tmpdir(), "orvyn-package-"));
try {
  await mkdir(destination, { recursive: true });
  await run("docker", [
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "-v",
    `${root}:/repo:ro`,
    "-v",
    `${temp}:/output`,
    "-w",
    "/repo",
    helmImage,
    "package",
    "infrastructure/helm/orvyn",
    "--destination",
    "/output",
  ]);
  // Helm archives contain current tar timestamps. Normalize them so retries of a
  // commit produce identical signed bytes and cannot conflict with a draft.
  const extract = join(temp, "extract");
  await mkdir(extract);
  await run("tar", ["-xzf", join(temp, `orvyn-${version}.tgz`), "-C", extract]);
  const { stdout } = await run(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=ustar",
      "--mode=u=rwX,go=rX",
      "-cf",
      "-",
      "-C",
      extract,
      "orvyn",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const bytes = gzipSync(stdout, { level: 9 });
  const filename = `orvyn-${version}.tgz`;
  await writeFile(join(destination, filename), bytes);
  await writeFile(
    join(destination, "chart.json"),
    JSON.stringify(
      {
        version,
        commit,
        filename,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Packaged deterministic ${filename}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
