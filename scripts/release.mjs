import { readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const components = ["web", "api", "collaboration", "worker"];
export const root = fileURLToPath(new URL("../", import.meta.url));
export function semver(value) {
  if (typeof value !== "string" || value.length > 100)
    throw Error("Use a SemVer version up to 100 characters.");
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(
      value,
    );
  if (
    !match ||
    match[0] !== value ||
    match[4]
      ?.split(".")
      .some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")
  )
    throw Error("Use a canonical SemVer version.");
  return {
    version: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null,
  };
}
export function compareVersions(a, b) {
  const left = semver(a),
    right = semver(b);
  for (const key of ["major", "minor", "patch"])
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const x = left.prerelease.split("."),
    y = right.prerelease.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] === y[i]) continue;
    const xn = /^\d+$/.test(x[i]),
      yn = /^\d+$/.test(y[i]);
    if (xn && yn) return BigInt(x[i]) > BigInt(y[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}
export async function manifests(directory = root) {
  const paths = ["package.json"];
  for (const parent of ["apps", "packages"]) {
    let children;
    try {
      children = await readdir(resolve(directory, parent), {
        withFileTypes: true,
      });
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name)))
      if (child.isDirectory()) {
        const path = `${parent}/${child.name}/package.json`;
        try {
          const value = JSON.parse(
            await readFile(resolve(directory, path), "utf8"),
          );
          if (value.name?.startsWith("@orvyn/")) paths.push(path);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
  }
  const result = [];
  for (const path of paths) {
    const content = await readFile(resolve(directory, path), "utf8");
    result.push({ path, content, data: JSON.parse(content) });
  }
  return result;
}
export async function checkVersions(directory = root) {
  const files = await manifests(directory),
    version = files[0].data.version;
  semver(version);
  for (const file of files)
    if (file.data.version !== version)
      throw Error(
        `Version mismatch in ${file.path}; run pnpm release:version with an explicit version.`,
      );
  // Desktop version formats need to be integrated with the actual Tauri client.
  // Never silently leave a future Cargo/Tauri application at another version.
  await checkDesktop(directory);
  return { version, files };
}
async function checkDesktop(directory) {
  const desktop = resolve(directory, "apps/desktop");
  try {
    const entries = await readdir(desktop);
    if (entries.length)
      throw Error(
        "Integrate Tauri/Cargo version synchronization before releasing a desktop client.",
      );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
export async function setVersion(
  choice,
  { directory = root, dryRun = false } = {},
) {
  await checkDesktop(directory);
  const explicit = !["major", "minor", "patch"].includes(choice),
    files = explicit
      ? await manifests(directory)
      : (await checkVersions(directory)).files,
    current = files[0].data.version,
    parsed = semver(current);
  const next =
    choice === "major"
      ? `${parsed.major + (parsed.prerelease && parsed.minor === 0n && parsed.patch === 0n ? 0n : 1n)}.0.0`
      : choice === "minor"
        ? `${parsed.major}.${parsed.minor + (parsed.prerelease && parsed.patch === 0n ? 0n : 1n)}.0`
        : choice === "patch"
          ? `${parsed.major}.${parsed.minor}.${parsed.patch + (parsed.prerelease ? 0n : 1n)}`
          : choice;
  semver(next);
  const changes = files.map((file) => ({
    ...file,
    next: JSON.stringify({ ...file.data, version: next }, null, 2) + "\n",
  }));
  if (!dryRun) {
    const done = [];
    try {
      for (const file of changes) {
        const target = resolve(directory, file.path),
          temp = resolve(dirname(target), `.orvyn-version-${randomUUID()}.tmp`);
        try {
          await writeFile(temp, file.next, { flag: "wx" });
          await rename(temp, target);
          done.push(file);
        } finally {
          await unlink(temp).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
        }
      }
    } catch (e) {
      for (const file of done.reverse())
        await writeFile(resolve(directory, file.path), file.content);
      throw e;
    }
  }
  return {
    previous: current,
    version: next,
    dryRun,
    files: files.map((file) => file.path),
  };
}
export async function releasePlan(tag, repository, { directory = root } = {}) {
  const { version } = await checkVersions(directory);
  if (tag !== "v" + version)
    throw Error(
      "Release tag must exactly match v followed by every manifest version.",
    );
  if (
    typeof repository !== "string" ||
    repository.trim() !== repository ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(
      repository,
    )
  )
    throw Error("Use a valid owner/repository name.");
  const parsed = semver(version),
    imageTag = version.replace("+", "_");
  return {
    tag,
    version,
    repository,
    prerelease: !!parsed.prerelease,
    imageTag,
    images: Object.fromEntries(
      components.map((name) => [
        name,
        `ghcr.io/${repository.toLowerCase()}-${name}`,
      ]),
    ),
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check" && !args.length) {
    const value = await checkVersions();
    console.log("All Orvyn manifests use " + value.version);
    return;
  }
  if (command === "version") {
    if (!args[0] || args.slice(1).some((arg) => arg !== "--dry-run"))
      throw Error(
        "Usage: pnpm release:version <patch|minor|major|SemVer> [--dry-run]",
      );
    console.log(
      JSON.stringify(
        await setVersion(args[0], { dryRun: args.includes("--dry-run") }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "plan" && !args.length) {
    const plan = await releasePlan(
      process.env.RELEASE_TAG,
      process.env.GITHUB_REPOSITORY,
    );
    console.log(JSON.stringify(plan));
    return;
  }
  throw Error("Choose check, version or plan.");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
