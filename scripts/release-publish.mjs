import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  releasePlan,
  components,
  compareVersions,
  semver,
} from "./release.mjs";
const execute = promisify(execFile),
  hash = (value) => createHash("sha256").update(value).digest("hex");
export function imageRecords(plan, commit, values) {
  if (
    commit?.length !== 40 ||
    !/^[a-f0-9]{40}$/.test(commit || "") ||
    values.length !== components.length
  )
    throw Error("Expected four image records for the checked release commit.");
  return components.map((component) => {
    const found = values.filter((value) => value.component === component);
    if (found.length !== 1)
      throw Error("Each release component must occur exactly once.");
    const record = found[0];
    if (
      record.version !== plan.version ||
      record.commit !== commit ||
      record.image !== plan.images[component] ||
      record.digest?.length !== 71 ||
      !/^sha256:[a-f0-9]{64}$/.test(record.digest || "")
    )
      throw Error("Image metadata does not match the checked release.");
    return { component, image: record.image, digest: record.digest };
  });
}
export async function readImageRecords(directory) {
  const selected = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = /^image-(web|api|collaboration|worker)-([1-9]\d*)$/.exec(
      entry.name,
    );
    if (!entry.isDirectory() || !match || match[0] !== entry.name)
      throw Error("Unexpected image-record artifact layout.");
    const attempt = BigInt(match[2]),
      current = selected.get(match[1]);
    if (!current || attempt > current.attempt)
      selected.set(match[1], {
        attempt,
        path: resolve(directory, entry.name, match[1] + ".json"),
      });
  }
  const records = [];
  for (const component of components) {
    const source = selected.get(component);
    if (!source) throw Error("An image-record artifact is missing.");
    const value = JSON.parse(await readFile(source.path, "utf8"));
    if (value.component !== component)
      throw Error("Image-record artifact name and component disagree.");
    records.push(value);
  }
  return records;
}
export function mayAdvanceLatest(plan, versions) {
  if (plan.prerelease) return false;
  return versions.every(
    (version) => compareVersions(plan.version, version) >= 0,
  );
}
export class GitHub {
  constructor({ repository, token, base = "https://api.github.com" }) {
    const url = new URL(base);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw Error("GitHub API requires HTTPS.");
    if (!token) throw Error("GH_TOKEN is required for release publication.");
    this.repository = repository;
    this.token = token;
    this.base = url.origin;
  }
  async request(
    path,
    { method = "GET", body, raw = false, missing = false } = {},
  ) {
    const url = new URL(path, this.base);
    if (
      url.origin !== this.base &&
      !(
        this.base === "https://api.github.com" &&
        url.origin === "https://uploads.github.com"
      )
    )
      throw Error("Untrusted release upload destination.");
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: "Bearer " + this.token,
        "User-Agent": "orvyn-release",
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: raw
          ? "application/octet-stream"
          : "application/vnd.github+json",
        ...(body === undefined
          ? {}
          : {
              "Content-Type": Buffer.isBuffer(body)
                ? "application/octet-stream"
                : "application/json",
            }),
      },
      body:
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? body
            : JSON.stringify(body),
    });
    if (missing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (raw && response.status === 302) {
      const location = new URL(response.headers.get("location"));
      await response.body?.cancel();
      if (
        location.protocol !== "https:" ||
        !location.hostname.endsWith(".githubusercontent.com")
      )
        throw Error("Unexpected release download destination.");
      const download = await fetch(location, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!download.ok) throw Error("Release asset download failed.");
      return Buffer.from(await download.arrayBuffer());
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        `GitHub request failed (${response.status}); no existing artifact was overwritten.`,
      );
    }
    return raw
      ? Buffer.from(await response.arrayBuffer())
      : response.status === 204
        ? null
        : response.json();
  }
  async pages(path, { missing = false } = {}) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const values = await this.request(
        path + (path.includes("?") ? "&" : "?") + `per_page=100&page=${page}`,
        { missing },
      );
      if (values === null) {
        if (page !== 1)
          throw Error(
            "Package history changed during verification; retry the release.",
          );
        return [];
      }
      if (!Array.isArray(values))
        throw Error("Unexpected paginated GitHub response.");
      rows.push(...values);
      if (values.length < 100) return rows;
    }
    throw Error(
      "Release history exceeds the verification limit; refusing an unchecked publication.",
    );
  }
}
export async function preflight(api, plan, records, fingerprint) {
  const repoPath = "/repos/" + plan.repository,
    [repo, release, releases] = await Promise.all([
      api.request(repoPath),
      api.request(repoPath + "/releases/tags/" + encodeURIComponent(plan.tag), {
        missing: true,
      }),
      api.pages(repoPath + "/releases"),
    ]);
  if (
    release &&
    (!release.draft || !release.body?.includes(`<!-- orvyn:${fingerprint} -->`))
  )
    throw Error(
      "This release already exists. Existing releases and unrelated drafts are never overwritten.",
    );
  const namespace =
    repo.owner?.type === "Organization"
      ? "orgs"
      : repo.owner?.type === "User"
        ? "users"
        : null;
  if (!namespace) throw Error("Unknown repository owner type.");
  const stable = [];
  for (const item of releases)
    if (!item.draft && !item.prerelease) {
      try {
        const value = semver(item.tag_name?.replace(/^v/, ""));
        if (!value.prerelease) stable.push(value.version);
      } catch {
        throw Error(
          "Cannot safely compare an existing stable release version.",
        );
      }
    }
  const states = await Promise.all(
    records.map(async (record) => {
      const [owner, name] = record.image.split("/").slice(1),
        versions = await api.pages(
          `/${namespace}/${owner}/packages/container/${encodeURIComponent(name)}/versions`,
          { missing: true },
        ),
        matches = versions.filter((value) =>
          value.metadata?.container?.tags?.includes(plan.imageTag),
        );
      if (
        matches.length > 1 ||
        matches.some((value) => value.name !== record.digest)
      )
        throw Error(
          "A versioned image already exists with different content; use a new version.",
        );
      const latest = versions.filter((value) =>
        value.metadata?.container?.tags?.includes("latest"),
      );
      if (latest.length > 1) throw Error("Ambiguous latest image tag.");
      for (const image of latest) {
        const candidates = (image.metadata.container.tags || []).flatMap(
          (tag) => {
            try {
              const version = semver(tag.replace("_", "+"));
              return version.prerelease ? [] : [version.version];
            } catch {
              return [];
            }
          },
        );
        if (!candidates.length)
          throw Error(
            "The existing latest image has no comparable stable version tag.",
          );
        stable.push(...candidates);
      }
      return { record, exists: matches.length === 1 };
    }),
  );
  return { release, states, latest: mayAdvanceLatest(plan, stable) };
}
export async function publish({ api, plan, commit, records, directory, run }) {
  const ref = await api.request(
    "/repos/" +
      plan.repository +
      "/git/ref/tags/" +
      encodeURIComponent(plan.tag),
  );
  let object = ref.object,
    depth = 0;
  while (object?.type === "tag" && depth++ < 5)
    object = (
      await api.request("/repos/" + plan.repository + "/git/tags/" + object.sha)
    ).object;
  if (object?.type !== "commit" || object.sha !== commit)
    throw Error(
      "The remote release tag does not identify the validated commit.",
    );
  const manifest =
      JSON.stringify(
        {
          format: "orvyn-server-release",
          version: plan.version,
          tag: plan.tag,
          commit,
          platforms: ["linux/amd64", "linux/arm64"],
          images: Object.fromEntries(
            records.map((record) => [
              record.component,
              {
                reference: record.image + "@" + record.digest,
                tag: record.image + ":" + plan.imageTag,
              },
            ]),
          ),
        },
        null,
        2,
      ) + "\n",
    fingerprint = hash(manifest),
    checked = await preflight(api, plan, records, fingerprint),
    repoPath = "/repos/" + plan.repository,
    identity = `https://github.com/${plan.repository}/.github/workflows/release.yml@refs/tags/${plan.tag}`,
    verify = [
      "--certificate-identity",
      identity,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
    ];
  // The registry index itself must contain both promised architectures.
  for (const record of records) {
    const value = JSON.parse(
        await run("docker", [
          "buildx",
          "imagetools",
          "inspect",
          record.image + "@" + record.digest,
          "--raw",
        ]),
      ),
      platforms = new Set(
        value.manifests?.map(
          (item) => item.platform?.os + "/" + item.platform?.architecture,
        ),
      );
    if (
      !["linux/amd64", "linux/arm64"].every((platform) =>
        platforms.has(platform),
      )
    )
      throw Error("A release image is missing a promised architecture.");
  }
  let release = checked.release;
  if (!release) {
    const notes = await api.request(repoPath + "/releases/generate-notes", {
      method: "POST",
      body: { tag_name: plan.tag, target_commitish: commit },
    });
    release = await api.request(repoPath + "/releases", {
      method: "POST",
      body: {
        tag_name: plan.tag,
        target_commitish: commit,
        name: "Orvyn " + plan.tag,
        draft: true,
        prerelease: plan.prerelease,
        make_latest: "false",
        body: `<!-- orvyn:${fingerprint} -->\n\n${notes.body || ""}\n\nServer images for Web, API, Collaboration and Worker. Use the attached manifest to pin their exact digests. Desktop applications are not included.`,
      },
    });
  }
  await mkdir(directory, { recursive: true });
  const filename = `orvyn-${plan.version}-server-images.json`,
    sums = hash(manifest) + "  " + filename + "\n",
    contents = new Map([
      [filename, Buffer.from(manifest)],
      ["SHA256SUMS", Buffer.from(sums)],
    ]),
    assets = await api.pages(repoPath + `/releases/${release.id}/assets`);
  async function retain(name, bytes) {
    const existing = assets.find((asset) => asset.name === name);
    if (existing) {
      const actual = await api.request(
        repoPath + `/releases/assets/${existing.id}`,
        { raw: true },
      );
      if (hash(actual) !== hash(bytes))
        throw Error(
          "An existing release asset has different content; it was not overwritten.",
        );
    } else {
      const upload = new URL(release.upload_url.replace(/\{.*$/, ""));
      upload.searchParams.set("name", name);
      await api.request(upload.toString(), { method: "POST", body: bytes });
    }
  }
  for (const [name, bytes] of contents) {
    await writeFile(resolve(directory, name), bytes);
    await retain(name, bytes);
  }
  const bundle = "SHA256SUMS.sigstore.json",
    existing = assets.find((asset) => asset.name === bundle),
    bundlePath = resolve(directory, bundle),
    sumsPath = resolve(directory, "SHA256SUMS");
  if (existing)
    await writeFile(
      bundlePath,
      await api.request(repoPath + `/releases/assets/${existing.id}`, {
        raw: true,
      }),
    );
  else
    await run("cosign", [
      "sign-blob",
      "--yes",
      "--bundle",
      bundlePath,
      sumsPath,
    ]);
  await run("cosign", [
    "verify-blob",
    "--bundle",
    bundlePath,
    ...verify,
    sumsPath,
  ]);
  if (!existing) await retain(bundle, await readFile(bundlePath));
  for (const { record } of checked.states) {
    await run("cosign", ["sign", "--yes", record.image + "@" + record.digest]);
    await run("cosign", [
      "verify",
      ...verify,
      record.image + "@" + record.digest,
    ]);
  }
  // Signatures and assets are ready before any public version aliases move.
  for (const { record, exists } of checked.states) {
    if (!exists)
      await run("docker", [
        "buildx",
        "imagetools",
        "create",
        "--tag",
        record.image + ":" + plan.imageTag,
        record.image + "@" + record.digest,
      ]);
    const digest = (
      await run("docker", [
        "buildx",
        "imagetools",
        "inspect",
        "--format",
        "{{.Manifest.Digest}}",
        record.image + ":" + plan.imageTag,
      ])
    ).trim();
    if (digest !== record.digest)
      throw Error("Promoted image digest did not match the tested release.");
  }
  if (checked.latest)
    for (const record of records) {
      await run("docker", [
        "buildx",
        "imagetools",
        "create",
        "--tag",
        record.image + ":latest",
        record.image + "@" + record.digest,
      ]);
      if (
        (
          await run("docker", [
            "buildx",
            "imagetools",
            "inspect",
            "--format",
            "{{.Manifest.Digest}}",
            record.image + ":latest",
          ])
        ).trim() !== record.digest
      )
        throw Error("Latest image digest did not match the checked release.");
    }
  await api.request(repoPath + `/releases/${release.id}`, {
    method: "PATCH",
    body: {
      draft: false,
      prerelease: plan.prerelease,
      make_latest: checked.latest ? "true" : "false",
    },
  });
  return { tag: plan.tag, latest: checked.latest, url: release.html_url };
}
async function main() {
  const plan = await releasePlan(
      process.env.RELEASE_TAG,
      process.env.GITHUB_REPOSITORY,
    ),
    commit = process.env.RELEASE_COMMIT,
    directory = resolve(process.env.RELEASE_RECORDS || "artifacts"),
    values = await readImageRecords(directory);
  if ((await execute("git", ["rev-parse", "HEAD"])).stdout.trim() !== commit)
    throw Error(
      "Publisher checkout does not match the validated release commit.",
    );
  const records = imageRecords(plan, commit, values),
    api = new GitHub({
      repository: plan.repository,
      token: process.env.GH_TOKEN,
      base: process.env.GITHUB_API_URL || "https://api.github.com",
    });
  const result = await publish({
    api,
    plan,
    commit,
    records,
    directory: resolve(".local/release-output", plan.tag),
    run: async (command, args) => {
      try {
        const result = await execute(command, args, {
          maxBuffer: 8 * 1024 * 1024,
        });
        return result.stdout;
      } catch {
        throw Error(
          command +
            " failed during release publication. The draft and completed immutable artifacts are retained for review/retry.",
        );
      }
    },
  });
  console.log(JSON.stringify(result));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
