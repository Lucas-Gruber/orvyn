import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { helmImage } from "./helm-tools.mjs";
import { inspectManifest } from "./release-platforms.mjs";

export async function readChartArtifact(directory, plan, commit) {
  const entries = await readdir(directory);
  if (!entries.includes("chart.json")) {
    if (
      !entries.length ||
      entries.some((name) => !/^helm-package-[1-9][0-9]*$/.test(name))
    )
      throw Error("Unexpected Helm artifact directory");
    const latest = entries.sort(
      (a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)),
    )[0];
    return readChartArtifact(resolve(directory, latest), plan, commit);
  }
  const metadata = JSON.parse(
    await readFile(resolve(directory, "chart.json"), "utf8"),
  );
  const filename = `orvyn-${plan.version}.tgz`;
  if (
    metadata.version !== plan.version ||
    metadata.commit !== commit ||
    metadata.filename !== filename ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw Error("Helm package metadata does not match the validated release");
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(["chart.json", filename].sort()))
    throw Error("Unexpected or missing Helm release artifacts");
  const path = resolve(directory, filename),
    bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256)
    throw Error("Helm package bytes do not match the checked digest");
  return { ...metadata, path, bytes };
}
export function validateChartManifest(value, chart) {
  if (
    value.config?.mediaType !== "application/vnd.cncf.helm.config.v1+json" ||
    value.layers?.length !== 1 ||
    value.layers[0].mediaType !==
      "application/vnd.cncf.helm.chart.content.v1.tar+gzip" ||
    value.layers[0].digest !== "sha256:" + chart.sha256
  )
    throw Error(
      "Existing or published chart does not match the checked Helm package; use a new version",
    );
}
export async function preflightChart(api, plan, chart, namespace, run) {
  const owner = plan.repository.split("/")[0].toLowerCase();
  const versions = await api.pages(
    `/${namespace}/${owner}/packages/container/${encodeURIComponent("charts/orvyn")}/versions`,
    { missing: true },
  );
  const matches = versions.filter((value) =>
    value.metadata?.container?.tags?.includes(plan.imageTag),
  );
  if (matches.length > 1) throw Error("Ambiguous immutable Helm chart version");
  if (!matches.length) return null;
  const existing = await inspectManifest(
    run,
    plan.chart.repository + "@" + matches[0].name,
  );
  if (existing.digest !== matches[0].name)
    throw Error("Helm registry manifest digest mismatch");
  validateChartManifest(existing.manifest, chart);
  return existing.digest;
}
export async function publishChart(plan, chart, existing, verify, run) {
  const repository = plan.chart.repository;
  if (!existing) {
    const dockerConfig = resolve(
      process.env.DOCKER_CONFIG || resolve(homedir(), ".docker"),
      "config.json",
    );
    await run("docker", [
      "run",
      "--rm",
      "--user",
      "0:0",
      "-v",
      `${dirname(chart.path)}:/charts:ro`,
      "-v",
      `${dockerConfig}:/registry/config.json:ro`,
      "-v",
      "/etc/ssl/certs/ca-certificates.crt:/certs/ca.crt:ro",
      "-e",
      "SSL_CERT_FILE=/certs/ca.crt",
      helmImage,
      "push",
      "/charts/" + chart.filename,
      "oci://" + repository.slice(0, repository.lastIndexOf("/")),
      "--registry-config",
      "/registry/config.json",
    ]);
  }
  const result = await inspectManifest(run, repository + ":" + plan.imageTag);
  validateChartManifest(result.manifest, chart);
  if (existing && result.digest !== existing)
    throw Error("Immutable Helm chart version changed during publication");
  const reference = repository + "@" + result.digest;
  await run("cosign", ["sign", "--yes", reference]);
  await run("cosign", ["verify", ...verify, reference]);
  return reference;
}
