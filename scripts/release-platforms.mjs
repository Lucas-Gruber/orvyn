import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { components } from "./release.mjs";

export const architectures = ["amd64", "arm64"];
export function manifestDigest(raw) {
  JSON.parse(raw);
  return "sha256:" + createHash("sha256").update(raw).digest("hex");
}
export async function inspectManifest(run, reference) {
  const raw = await run("docker", [
    "buildx",
    "imagetools",
    "inspect",
    "--raw",
    reference,
  ]);
  return { manifest: JSON.parse(raw), digest: manifestDigest(raw) };
}
export async function readPlatformRecords(directory) {
  const selected = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match =
      /^platform-(web|api|collaboration|worker)-(amd64|arm64)-([1-9]\d*)$/.exec(
        entry.name,
      );
    if (!entry.isDirectory() || !match || match[0] !== entry.name)
      throw Error("Unexpected platform-record artifact layout.");
    const key = match[1] + "/" + match[2],
      attempt = BigInt(match[3]);
    if (!selected.has(key) || selected.get(key).attempt < attempt)
      selected.set(key, {
        attempt,
        path: resolve(
          directory,
          entry.name,
          match[1] + "-" + match[2] + ".json",
        ),
      });
  }
  const values = [];
  for (const component of components)
    for (const arch of architectures) {
      const source = selected.get(component + "/" + arch);
      if (!source) throw Error("A platform-record artifact is missing.");
      const value = JSON.parse(await readFile(source.path, "utf8"));
      if (value.component !== component || value.platform !== "linux/" + arch)
        throw Error("Platform-record artifact name and contents disagree.");
      values.push(value);
    }
  return values;
}
export async function mergePlatformImages({
  plan,
  commit,
  values,
  candidateTag,
  run,
}) {
  if (
    values.length !== 8 ||
    !/^[a-f0-9]{40}$/.test(commit || "") ||
    commit.length !== 40 ||
    !/^build-[1-9]\d*-[1-9]\d*$/.test(candidateTag || "")
  )
    throw Error("Expected eight platform records for the checked release run.");
  const checked = components.flatMap((component) =>
    architectures.map((arch) => {
      const found = values.filter(
        (value) =>
          value.component === component && value.platform === "linux/" + arch,
      );
      if (found.length !== 1)
        throw Error("Each component and architecture must occur exactly once.");
      const record = found[0];
      if (
        record.version !== plan.version ||
        record.commit !== commit ||
        record.image !== plan.images[component] ||
        record.digest?.length !== 71 ||
        !/^sha256:[a-f0-9]{64}$/.test(record.digest || "")
      )
        throw Error("Platform metadata does not match the checked release.");
      return record;
    }),
  );
  // Validate all immutable sources before creating any combined candidate.
  const sources = await Promise.all(
    checked.map(async (record) => {
      const { manifest, digest } = await inspectManifest(
        run,
        record.image + "@" + record.digest,
      );
      if (digest !== record.digest)
        throw Error(
          "Platform source digest does not match its registry bytes.",
        );
      const actual = manifest.manifests?.filter(
        (item) =>
          item.platform?.os === "linux" &&
          architectures.includes(item.platform?.architecture),
      );
      if (
        actual?.length !== 1 ||
        actual[0].platform.os + "/" + actual[0].platform.architecture !==
          record.platform ||
        !manifest.manifests.some(
          (item) =>
            item.annotations?.["vnd.docker.reference.type"] ===
              "attestation-manifest" &&
            item.annotations?.["vnd.docker.reference.digest"] ===
              actual[0].digest,
        )
      )
        throw Error(
          "A platform source is missing its architecture or attestation.",
        );
      return { record, manifest };
    }),
  );
  const records = [];
  for (const component of components) {
    const pair = sources.filter(
        (source) => source.record.component === component,
      ),
      image = plan.images[component],
      reference = image + ":" + candidateTag;
    await run("docker", [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      reference,
      ...pair.map((source) => image + "@" + source.record.digest),
    ]);
    const { manifest, digest } = await inspectManifest(run, reference),
      descriptors = new Set(manifest.manifests?.map((item) => item.digest));
    if (
      !pair.every((source) =>
        source.manifest.manifests.every((item) => descriptors.has(item.digest)),
      )
    )
      throw Error("Combined candidate lost a platform or its attestation.");
    records.push({ component, image, digest });
  }
  return records;
}
