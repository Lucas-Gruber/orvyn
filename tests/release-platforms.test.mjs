import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { components } from "../scripts/release.mjs";
import {
  architectures,
  manifestDigest,
  inspectManifest,
  readPlatformRecords,
  mergePlatformImages,
} from "../scripts/release-platforms.mjs";

const commit = "a".repeat(40),
  plan = {
    version: "1.2.3",
    images: Object.fromEntries(
      components.map((component) => [
        component,
        "ghcr.io/example/orvyn-" + component,
      ]),
    ),
  };
const sha = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const sources = new Map(),
    commands = [],
    merged = new Map();
  const values = components.flatMap((component) =>
    architectures.map((arch) => {
      const runtime = sha(component + arch),
        attestation = sha(component + arch + "attestation"),
        raw = JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            { digest: runtime, platform: { os: "linux", architecture: arch } },
            {
              digest: attestation,
              platform: { os: "unknown", architecture: "unknown" },
              annotations: {
                "vnd.docker.reference.type": "attestation-manifest",
                "vnd.docker.reference.digest": runtime,
              },
            },
          ],
        }),
        digest = sha(raw),
        image = plan.images[component];
      sources.set(image + "@" + digest, raw);
      return {
        component,
        platform: "linux/" + arch,
        image,
        digest,
        version: plan.version,
        commit,
      };
    }),
  );
  const run = async (command, args) => {
    assert.equal(command, "docker");
    commands.push(args);
    if (args.includes("--raw")) {
      const raw = sources.get(args.at(-1)) || merged.get(args.at(-1));
      assert.ok(
        raw,
        "only checked source or created candidates may be inspected",
      );
      return raw;
    }
    assert.ok(args.includes("create"));
    const offset = args.indexOf("--tag"),
      target = args[offset + 1];
    assert.match(target, /:build-123-[12]$/);
    merged.set(
      target,
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: args
          .slice(offset + 2)
          .flatMap((ref) => JSON.parse(sources.get(ref)).manifests),
      }),
    );
    return "";
  };
  return { sources, values, commands, merged, run };
}
test("registry digest checks hash exact raw manifest bytes instead of Buildx's special Manifest formatter", async () => {
  const raw = '{"manifests":[]}\n';
  const result = await inspectManifest(async (command, args) => {
    assert.equal(command, "docker");
    assert.deepEqual(args, [
      "buildx",
      "imagetools",
      "inspect",
      "--raw",
      "ghcr.io/example/image:1.2.3",
    ]);
    return raw;
  }, "ghcr.io/example/image:1.2.3");
  assert.equal(result.digest, sha(raw));
  assert.notEqual(result.digest, manifestDigest(raw.trim()));
  assert.throws(() => manifestDigest("Name: image\nDigest: sha256:invalid"));
});
test("eight native platform artifacts merge into four reproducible indexes while retaining architecture attestations", async () => {
  const f = fixture();
  const records = await mergePlatformImages({
    plan,
    commit,
    values: f.values,
    candidateTag: "build-123-1",
    run: f.run,
  });
  assert.deepEqual(
    records.map((record) => record.component),
    components,
  );
  for (const record of records) {
    const raw = f.merged.get(record.image + ":build-123-1");
    assert.equal(record.digest, sha(raw));
    assert.equal(JSON.parse(raw).manifests.length, 4);
  }
  assert.equal(
    f.commands.slice(0, 8).filter((args) => args.includes("--raw")).length,
    8,
  );
  const retry = await mergePlatformImages({
    plan,
    commit,
    values: f.values,
    candidateTag: "build-123-2",
    run: f.run,
  });
  assert.deepEqual(retry, records);
});
test("missing, duplicate, mismatched or substituted platform metadata never creates a candidate", async () => {
  for (const transform of [
    (values) => values.slice(1),
    (values) => [values[1], ...values.slice(1)],
    (values) =>
      values.map((value, i) =>
        i ? value : { ...value, commit: "b".repeat(40) },
      ),
    (values) =>
      values.map((value, i) =>
        i ? value : { ...value, image: "ghcr.io/other/image" },
      ),
  ]) {
    const f = fixture();
    await assert.rejects(
      mergePlatformImages({
        plan,
        commit,
        values: transform(f.values),
        candidateTag: "build-123-1",
        run: f.run,
      }),
    );
    assert.equal(f.commands.length, 0);
  }
  const f = fixture(),
    reference = [...f.sources.keys()][0];
  f.sources.set(reference, f.sources.get(reference) + "\n");
  await assert.rejects(
    mergePlatformImages({
      plan,
      commit,
      values: f.values,
      candidateTag: "build-123-1",
      run: f.run,
    }),
    /digest/,
  );
  assert.ok(!f.commands.some((args) => args.includes("create")));
});
test("merged candidates cannot lose an architecture's provenance and SBOM manifest", async () => {
  const f = fixture();
  await assert.rejects(
    mergePlatformImages({
      plan,
      commit,
      values: f.values,
      candidateTag: "build-123-1",
      run: async (command, args) => {
        const raw = await f.run(command, args);
        if (args.includes("--raw") && args.at(-1).includes(":build-")) {
          const index = JSON.parse(raw);
          index.manifests.pop();
          return JSON.stringify(index);
        }
        return raw;
      },
    }),
    /lost/,
  );
});
test("native artifact retries select the latest successful upload for each exact component and architecture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvyn-platforms-")),
    f = fixture();
  const save = async (record, attempt) => {
    const arch = record.platform.split("/")[1],
      folder = join(
        directory,
        `platform-${record.component}-${arch}-${attempt}`,
      );
    await mkdir(folder);
    const file = join(folder, `${record.component}-${arch}.json`);
    await writeFile(file, JSON.stringify(record));
    return file;
  };
  try {
    for (const value of f.values) await save(value, 1);
    assert.deepEqual(await readPlatformRecords(directory), f.values);
    const newer = { ...f.values[0], digest: "sha256:" + "d".repeat(64) },
      path = await save(newer, 2);
    assert.deepEqual((await readPlatformRecords(directory))[0], newer);
    await rm(path);
    await assert.rejects(readPlatformRecords(directory), /ENOENT/);
    await writeFile(
      path,
      JSON.stringify({ ...newer, platform: "linux/arm64" }),
    );
    await assert.rejects(readPlatformRecords(directory), /disagree/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
