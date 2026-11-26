import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import {
  readChartArtifact,
  validateChartManifest,
  preflightChart,
} from "../scripts/release-chart.mjs";
import { manifestDigest } from "../scripts/release-platforms.mjs";

test("real Node failures produce useful CI annotations with file positions and without secret or expected-TODO leakage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvyn-test-reporter-"));
  try {
    await mkdir(join(directory, "tests"));
    const path = join(directory, "tests", "reporter.fixture.test.mjs"),
      secret = "test-reporter-secret-" + "9".repeat(20),
      session = "ab".repeat(32);
    await writeFile(
      path,
      "import test from 'node:test';test('validator fails',()=>{throw Error('Intentional CI probe '+process.env.S3_SECRET_ACCESS_KEY+' '+process.env.SESSION_CANARY)});test('expected TODO',{todo:true},()=>{throw Error('Known pending feature')});",
    );
    const env = {
      ...process.env,
      S3_SECRET_ACCESS_KEY: secret,
      SESSION_CANARY: session,
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=" +
          new URL("../scripts/test-github-reporter.mjs", import.meta.url).href,
        path,
      ],
      {
        cwd: directory,
        env,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stdout,
      /::error title=Integration test failed,file=tests\/reporter\.fixture\.test\.mjs,line=1/,
    );
    assert.match(result.stdout, /Intentional CI probe/);
    assert.ok(
      !result.stdout.includes(secret) && !result.stdout.includes(session),
    );
    assert.ok(!result.stdout.includes("Known pending feature"));
    assert.equal(result.stdout.trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CI retains Kubernetes/integration logs and propagates failed validators through tee", async () => {
  const workflow = YAML.parse(
    await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), "orvyn-ci-status-"));
  try {
    for (const [name, file] of [
      [
        "Exercise production containers over HTTPS",
        "production-image-results.txt",
      ],
      [
        "Install and upgrade on Kubernetes with internal and local storage",
        "kubernetes-results.txt",
      ],
      ["Run complete integration suite", "test-results.txt"],
    ]) {
      const step = workflow.jobs.checks.steps.find(
        (step) => step.name === name,
      );
      assert.ok(step?.run);
      for (const code of [23, 0]) {
        // Execute the actual step script using the runner's weakest default
        // (-e without pipefail), substituting only the expensive test program.
        const script =
          "pnpm() { node; }; node() { printf '%s\\n' 'validator output'; return " +
          code +
          "; }\n" +
          step.run;
        const result = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-e", "-c", script],
          { cwd: directory, encoding: "utf8" },
        );
        assert.equal(result.status, code, result.stderr);
        assert.equal(
          await readFile(join(directory, file), "utf8"),
          "validator output\n",
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
import {
  semver,
  compareVersions,
  setVersion,
  checkVersions,
  releasePlan,
  components,
} from "../scripts/release.mjs";
import {
  imageRecords,
  readImageRecords,
  mayAdvanceLatest,
  preflight,
  publish,
  GitHub,
  safeReleaseError,
} from "../scripts/release-publish.mjs";
async function fixture(version = "1.2.3") {
  const directory = await mkdtemp(join(tmpdir(), "orvyn-release-"));
  for (const [path, name] of [
    ["package.json", "orvyn"],
    ["apps/web/package.json", "@orvyn/web"],
    ["packages/editor/package.json", "@orvyn/editor"],
    ["packages/foreign/package.json", "foreign-package"],
  ]) {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(
      target,
      JSON.stringify({
        name,
        version: name === "foreign-package" ? "8.0.0" : version,
        dependencies: { dependency: "^9.4.1" },
      }) + "\n",
    );
  }
  return {
    directory,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
test("chart and appVersion follow atomic version changes and mismatches fail release checks", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "infrastructure/helm/orvyn");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "Chart.yaml"),
      'apiVersion: v2\nname: orvyn\nversion: "1.2.3"\nappVersion: "1.2.3"\n# keep metadata\n',
    );
    await setVersion("minor", { directory: f.directory });
    assert.equal((await checkVersions(f.directory)).version, "1.3.0");
    const content = await readFile(join(path, "Chart.yaml"), "utf8");
    assert.match(content, /appVersion: "1.3.0"/);
    assert.match(content, /# keep metadata/);
    const plan = await releasePlan("v1.3.0", "Example/Orvyn", {
      directory: f.directory,
    });
    assert.equal(plan.chart.repository, "ghcr.io/example/charts/orvyn");
    await writeFile(
      join(path, "Chart.yaml"),
      content.replace('appVersion: "1.3.0"', 'appVersion: "latest"'),
    );
    await assert.rejects(checkVersions(f.directory), /mismatch/);
    await writeFile(join(path, "Chart.yaml"), content + "version: 1.3.0\n");
    await assert.rejects(checkVersions(f.directory), /exactly one/);
  } finally {
    await f.dispose();
  }
});
test("Helm release artifacts reject changed bytes and foreign source metadata", async () => {
  const f = await fixture(),
    p = plan(),
    bytes = Buffer.from("checked chart archive"),
    filename = "orvyn-1.2.3.tgz";
  try {
    const path = join(f.directory, "chart");
    await mkdir(path);
    const metadata = {
      version: p.version,
      commit,
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(join(path, filename), bytes);
    await writeFile(join(path, "chart.json"), JSON.stringify(metadata));
    assert.deepEqual((await readChartArtifact(path, p, commit)).bytes, bytes);
    await writeFile(join(path, filename), "tampered");
    await assert.rejects(readChartArtifact(path, p, commit), /digest/);
    await writeFile(join(path, filename), bytes);
    await assert.rejects(
      readChartArtifact(path, p, "b".repeat(40)),
      /validated release/,
    );
  } finally {
    await f.dispose();
  }
});
test("Helm publishing happens after all four verified image tags and signs the checked chart digest", async () => {
  const f = await fixture(),
    p = {
      ...plan(),
      chart: { repository: "ghcr.io/example/charts/orvyn", version: "1.2.3" },
    },
    api = fakeApi(p),
    commands = [];
  const bytes = Buffer.from("checked chart package"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const chart = {
    filename: "orvyn-1.2.3.tgz",
    path: join(f.directory, "orvyn-1.2.3.tgz"),
    bytes,
    sha256,
  };
  const chartManifest = {
    schemaVersion: 2,
    config: { mediaType: "application/vnd.cncf.helm.config.v1+json" },
    layers: [
      {
        mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
        digest: "sha256:" + sha256,
      },
    ],
  };
  try {
    const result = await publish({
      api,
      plan: p,
      commit,
      records: records(p),
      directory: f.directory,
      chart,
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (args.includes("--raw"))
          return JSON.stringify(
            args.at(-1).includes("/charts/")
              ? chartManifest
              : {
                  manifests: [
                    { platform: { os: "linux", architecture: "amd64" } },
                    { platform: { os: "linux", architecture: "arm64" } },
                  ],
                },
          );
        if (args[0] === "sign-blob")
          await writeFile(args[args.indexOf("--bundle") + 1], "test bundle");
        return "";
      },
    });
    const pushed = commands.findIndex((c) => c.includes("push"));
    assert.ok(pushed > 0);
    assert.equal(
      commands.slice(0, pushed).filter((c) => c.includes("create")).length,
      4,
    );
    assert.equal(
      commands
        .slice(0, pushed)
        .filter((c) => c.includes("--raw") && c.at(-1).endsWith(":1.2.3"))
        .length,
      4,
    );
    assert.ok(result.chart.startsWith(p.chart.repository + "@sha256:"));
    assert.ok(
      commands.some(
        (c) =>
          c[0] === "cosign" && c[1] === "verify" && c.at(-1) === result.chart,
      ),
    );
    assert.deepEqual(api.uploads.get(chart.filename), bytes);
    assert.match(
      api.uploads.get("SHA256SUMS").toString(),
      new RegExp(sha256 + "  orvyn-1.2.3.tgz"),
    );
    assert.equal(api.writes.at(-1).body.draft, false);
    const conflict = fakeApi(p, {
      versions: (path) =>
        path.includes("charts%2Forvyn")
          ? [
              {
                name: "sha256:" + "a".repeat(64),
                metadata: { container: { tags: ["1.2.3"] } },
              },
            ]
          : [],
    });
    await assert.rejects(
      preflightChart(conflict, p, chart, "users", async () =>
        JSON.stringify(chartManifest),
      ),
      /digest mismatch/,
    );
    assert.throws(
      () =>
        validateChartManifest(
          {
            ...chartManifest,
            layers: [
              {
                ...chartManifest.layers[0],
                digest: "sha256:" + "0".repeat(64),
              },
            ],
          },
          chart,
        ),
      /checked Helm package/,
    );
  } finally {
    await f.dispose();
  }
});
test("public release diagnostics remove credential bindings, bearer tokens and signed URL credentials", () => {
  const message = safeReleaseError(
    "Failure with repo-secret and id-secret Bearer bearer-secret eyJhbGciOiJFUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl https://example.invalid/?X-Amz-Signature=url-secret&name=file",
    { GH_TOKEN: "repo-secret", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id-secret" },
  );
  for (const value of [
    "repo-secret",
    "id-secret",
    "bearer-secret",
    "eyJhbGci",
    "url-secret",
  ])
    assert.ok(!message.includes(value));
  assert.ok(message.includes("&name=file"));
});
test("release versions follow SemVer precedence, numeric prereleases and stable finalization", async () => {
  for (const invalid of [
    "v1.2.3",
    "1.02.3",
    "1.2.3-01",
    "1.2",
    "1.2.3/evil",
    "1.2.3\n",
    "1.2.3-",
    "1.2.3+bad_",
  ])
    assert.throws(() => semver(invalid));
  for (const value of [
    "1.2.3",
    "0.0.0",
    "1.2.3-rc.10+build.0001",
    "12345678901234567890.0.0",
  ])
    assert.equal(semver(value).version, value);
  const versions = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 1; i < versions.length; i++)
    assert.equal(compareVersions(versions[i - 1], versions[i]), -1);
  assert.equal(compareVersions("1.0.0+one", "1.0.0+two"), 0);
  const f = await fixture("1.0.0-rc.2");
  try {
    assert.equal(
      (await setVersion("major", { directory: f.directory, dryRun: true }))
        .version,
      "1.0.0",
    );
    assert.equal(
      (await setVersion("patch", { directory: f.directory, dryRun: true }))
        .version,
      "1.0.0",
    );
  } finally {
    await f.dispose();
  }
});
test("version commands synchronize only owned manifests, preserve dependencies, support dry-run and repair explicit drift without touching git", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.directory, "package.json"), "utf8");
    assert.equal(
      (await setVersion("minor", { directory: f.directory, dryRun: true }))
        .version,
      "1.3.0",
    );
    assert.equal(
      await readFile(join(f.directory, "package.json"), "utf8"),
      before,
    );
    await setVersion("2.0.0-rc.1+build.5", { directory: f.directory });
    assert.equal(
      (await checkVersions(f.directory)).version,
      "2.0.0-rc.1+build.5",
    );
    const foreign = JSON.parse(
      await readFile(join(f.directory, "packages/foreign/package.json")),
    );
    assert.equal(foreign.version, "8.0.0");
    assert.equal(
      JSON.parse(await readFile(join(f.directory, "apps/web/package.json")))
        .dependencies.dependency,
      "^9.4.1",
    );
    await writeFile(
      join(f.directory, "apps/web/package.json"),
      JSON.stringify({ name: "@orvyn/web", version: "9.0.0" }),
    );
    await assert.rejects(checkVersions(f.directory), /mismatch/);
    await assert.rejects(
      setVersion("patch", { directory: f.directory }),
      /mismatch/,
    );
    await setVersion("2.0.0", { directory: f.directory });
    assert.equal((await checkVersions(f.directory)).version, "2.0.0");
    assert.ok(!(await readdir(f.directory)).includes(".git"));
  } finally {
    await f.dispose();
  }
});
test("release plans reject mismatched tags and repositories, separate prereleases and encode metadata into valid Docker tags", async () => {
  const f = await fixture("2.0.0-rc.1+build.5");
  try {
    const plan = await releasePlan("v2.0.0-rc.1+build.5", "Example/Orvyn", {
      directory: f.directory,
    });
    assert.equal(plan.imageTag, "2.0.0-rc.1_build.5");
    assert.equal(plan.prerelease, true);
    assert.equal(plan.images.worker, "ghcr.io/example/orvyn-worker");
    await assert.rejects(
      releasePlan("v1.0.0", "Example/Orvyn", { directory: f.directory }),
      /exactly match/,
    );
    await assert.rejects(
      releasePlan(plan.tag, "Example/../evil", { directory: f.directory }),
      /repository/,
    );
    await mkdir(join(f.directory, "apps/desktop"));
    await writeFile(
      join(f.directory, "apps/desktop/Cargo.toml"),
      '[package]\nversion="2.0.0"',
    );
    await assert.rejects(checkVersions(f.directory), /Tauri/);
  } finally {
    await f.dispose();
  }
});
const commit = "a".repeat(40),
  digest = manifestDigest(
    JSON.stringify({
      manifests: [
        { platform: { os: "linux", architecture: "amd64" } },
        { platform: { os: "linux", architecture: "arm64" } },
      ],
    }),
  );
function plan(version = "1.2.3") {
  return {
    tag: "v" + version,
    version,
    imageTag: version,
    prerelease: !!semver(version).prerelease,
    repository: "Example/Orvyn",
    images: Object.fromEntries(
      components.map((name) => [name, "ghcr.io/example/orvyn-" + name]),
    ),
  };
}
function records(p = plan()) {
  return components.map((component) => ({
    component,
    image: p.images[component],
    digest,
    version: p.version,
    commit,
  }));
}
function fakeApi(
  p = plan(),
  {
    release = null,
    versions = [],
    releases = [],
    assets = [],
    assetBytes = new Map(),
  } = {},
) {
  const writes = [],
    uploads = new Map(),
    api = {
      writes,
      uploads,
      pages: async (path) =>
        path.endsWith("/assets")
          ? assets
          : path.includes("/packages/")
            ? typeof versions === "function"
              ? versions(path)
              : versions
            : releases,
      request: async (path, options = {}) => {
        if (options.method) writes.push({ path, ...options });
        if (path.endsWith("/releases/generate-notes"))
          return { body: "Changes in this release" };
        if (path.includes("/git/ref/tags/"))
          return { object: { type: "commit", sha: commit } };
        if (path.endsWith("/releases") && options.method === "POST")
          return {
            id: 7,
            html_url: "https://github.com/Example/Orvyn/releases/tag/" + p.tag,
            upload_url:
              "https://uploads.github.com/example/assets{?name,label}",
          };
        if (
          options.method === "POST" &&
          path.startsWith("https://uploads.github.com")
        ) {
          uploads.set(new URL(path).searchParams.get("name"), options.body);
          return {};
        }
        if (path.includes("/releases/tags/")) return release;
        if (path.endsWith("/releases/7") && options.method === "PATCH")
          return {};
        if (path.includes("/releases/assets/"))
          return (
            assetBytes.get(Number(path.split("/").at(-1))) ||
            Buffer.from("Wrong existing artifact")
          );
        return { owner: { type: "User" } };
      },
    };
  return api;
}
test("release artifacts are bound to all four exact component images, versions and commits", () => {
  const p = plan();
  assert.equal(imageRecords(p, commit, records(p)).length, 4);
  for (const values of [
    records().slice(1),
    [...records().slice(1), records()[1]],
    records().map((value, i) =>
      i ? value : { ...value, image: "ghcr.io/attacker/api" },
    ),
    records().map((value, i) =>
      i ? value : { ...value, commit: "c".repeat(40) },
    ),
  ])
    assert.throws(() => imageRecords(p, commit, values));
  assert.equal(mayAdvanceLatest(p, ["1.2.2"]), true);
  assert.equal(mayAdvanceLatest(p, ["1.2.4"]), false);
  assert.equal(mayAdvanceLatest(plan("2.0.0-rc.1"), []), false);
});
test("artifact retries choose the newest successful record for each component and reject incomplete or foreign layouts", async () => {
  const f = await fixture(),
    folder = join(f.directory, "artifacts"),
    p = plan();
  try {
    await mkdir(folder);
    for (const record of records())
      for (const attempt of [1, 2]) {
        const path = join(folder, `image-${record.component}-${attempt}`);
        await mkdir(path);
        await writeFile(
          join(path, record.component + ".json"),
          JSON.stringify({
            ...record,
            digest: "sha256:" + String(attempt).repeat(64),
          }),
        );
      }
    assert.ok(
      imageRecords(p, commit, await readImageRecords(folder)).every(
        (record) => record.digest === "sha256:" + "2".repeat(64),
      ),
    );
    await rm(join(folder, "image-worker-2/worker.json"));
    await assert.rejects(readImageRecords(folder), /ENOENT/);
    await rm(join(folder, "image-worker-2"), { recursive: true });
    assert.equal(
      (await readImageRecords(folder)).find(
        (record) => record.component === "worker",
      ).digest,
      "sha256:" + "1".repeat(64),
    );
    await mkdir(join(folder, "image-unknown-3"));
    await assert.rejects(readImageRecords(folder), /Unexpected/);
  } finally {
    await f.dispose();
  }
});
test("release preflight never replaces a published release, mismatched image tag or incomparable latest channel", async () => {
  const p = plan(),
    r = records();
  await assert.rejects(
    preflight(fakeApi(p, { release: { draft: false } }), p, r, "hash"),
    /already exists/,
  );
  await assert.rejects(
    preflight(
      fakeApi(p, { release: { draft: true, body: "Some other draft" } }),
      p,
      r,
      "hash",
    ),
    /already exists/,
  );
  await assert.rejects(
    preflight(
      fakeApi(p, {
        versions: [
          {
            name: "sha256:" + "f".repeat(64),
            metadata: { container: { tags: [p.imageTag] } },
          },
        ],
      }),
      p,
      r,
      "hash",
    ),
    /different content/,
  );
  await assert.rejects(
    preflight(
      fakeApi(p, {
        versions: [
          { name: digest, metadata: { container: { tags: ["latest"] } } },
        ],
      }),
      p,
      r,
      "hash",
    ),
    /comparable/,
  );
  const newer = await preflight(
    fakeApi(p, {
      releases: [{ tag_name: "v9.0.0", draft: false, prerelease: false }],
    }),
    p,
    r,
    "hash",
  );
  assert.equal(newer.latest, false);
});
test("publication signs checked digests and checksum assets before promotion, and only then exposes the finished release", async () => {
  const f = await fixture(),
    p = plan(),
    api = fakeApi(p),
    commands = [];
  try {
    const result = await publish({
      api,
      plan: p,
      commit,
      records: records(p),
      directory: f.directory,
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (args.includes("--raw"))
          return JSON.stringify({
            manifests: [
              { platform: { os: "linux", architecture: "amd64" } },
              { platform: { os: "linux", architecture: "arm64" } },
            ],
          });
        if (args[0] === "sign-blob") {
          await writeFile(
            args[args.indexOf("--bundle") + 1],
            "Signed test bundle",
          );
          return "";
        }
        return "";
      },
    });
    assert.equal(result.latest, true);
    assert.equal(api.uploads.size, 3);
    assert.ok(
      api.uploads
        .get("SHA256SUMS")
        .toString()
        .includes("orvyn-1.2.3-server-images.json"),
    );
    const firstPromotion = commands.findIndex((value) =>
        value.includes("create"),
      ),
      lastVerification = commands.findLastIndex(
        (value) => value[0] === "cosign" && value[1] === "verify",
      );
    assert.ok(firstPromotion > lastVerification);
    assert.equal(commands.filter((value) => value[1] === "sign").length, 4);
    assert.equal(
      commands.filter((value) => value.includes("create")).length,
      8,
    );
    assert.equal(api.writes.at(-1).method, "PATCH");
    assert.deepEqual(api.writes.at(-1).body, {
      draft: false,
      prerelease: false,
      make_latest: "true",
    });
  } finally {
    await f.dispose();
  }
});
test("failed or incomplete publications keep drafts private and leave conflicting assets and image aliases intact", async () => {
  const f = await fixture(),
    p = plan();
  try {
    const api = fakeApi(p),
      commands = [];
    await assert.rejects(
      publish({
        api,
        plan: p,
        commit,
        records: records(),
        directory: f.directory,
        run: async (command, args) => {
          commands.push(args);
          return JSON.stringify({
            manifests: [{ platform: { os: "linux", architecture: "amd64" } }],
          });
        },
      }),
      /architecture/,
    );
    assert.equal(api.writes.length, 0);
    assert.ok(!commands.some((args) => args.includes("create")));
    const conflict = fakeApi(p, {
      assets: [{ id: 1, name: "orvyn-1.2.3-server-images.json" }],
    });
    await assert.rejects(
      publish({
        api: conflict,
        plan: p,
        commit,
        records: records(),
        directory: f.directory,
        run: async () =>
          JSON.stringify({
            manifests: [
              { platform: { os: "linux", architecture: "amd64" } },
              { platform: { os: "linux", architecture: "arm64" } },
            ],
          }),
      }),
      /not overwritten/,
    );
    assert.ok(!conflict.writes.some((value) => value.method === "PATCH"));
  } finally {
    await f.dispose();
  }
});
test("prerelease publication never changes latest, and signature failures never promote image aliases", async () => {
  const f = await fixture();
  const run = async (command, args) => {
    if (args.includes("--raw"))
      return JSON.stringify({
        manifests: [
          { platform: { os: "linux", architecture: "amd64" } },
          { platform: { os: "linux", architecture: "arm64" } },
        ],
      });
    if (args[0] === "sign-blob")
      await writeFile(
        args[args.indexOf("--bundle") + 1],
        "Verified test bundle",
      );
    return "";
  };
  try {
    const p = plan("2.0.0-rc.1"),
      api = fakeApi(p),
      commands = [];
    await publish({
      api,
      plan: p,
      commit,
      records: records(p),
      directory: f.directory,
      run: async (command, args) => {
        commands.push(args);
        return run(command, args);
      },
    });
    assert.ok(
      !commands.some((args) => args.some((value) => value.endsWith(":latest"))),
    );
    assert.deepEqual(api.writes.at(-1).body, {
      draft: false,
      prerelease: true,
      make_latest: "false",
    });
    const fail = fakeApi(),
      failedCommands = [];
    await assert.rejects(
      publish({
        api: fail,
        plan: plan(),
        commit,
        records: records(),
        directory: f.directory,
        run: async (command, args) => {
          failedCommands.push(args);
          if (args[0] === "verify-blob")
            throw Error("Signature verification failed");
          return run(command, args);
        },
      }),
      /Signature/,
    );
    assert.ok(!failedCommands.some((args) => args.includes("create")));
    assert.ok(!fail.writes.some((value) => value.method === "PATCH"));
  } finally {
    await f.dispose();
  }
});
test("a failed publishing job resumes the same draft and assets without replacing completed version tags", async () => {
  const f = await fixture(),
    p = plan(),
    api = fakeApi(p),
    promoted = new Set();
  let fail = true;
  async function run(command, args) {
    if (args.includes("--raw")) {
      if (!args.at(-1).includes("@")) assert.ok(promoted.has(args.at(-1)));
      return JSON.stringify({
        manifests: [
          { platform: { os: "linux", architecture: "amd64" } },
          { platform: { os: "linux", architecture: "arm64" } },
        ],
      });
    }
    if (args[0] === "sign-blob") {
      await writeFile(
        args[args.indexOf("--bundle") + 1],
        "Original signed bundle",
      );
      return "";
    }
    if (args.includes("create")) {
      const reference = args[args.indexOf("--tag") + 1];
      if (fail && reference === p.images.api + ":" + p.imageTag)
        throw Error("Interrupted promotion");
      promoted.add(reference);
    }
    return "";
  }
  try {
    await assert.rejects(
      publish({
        api,
        plan: p,
        commit,
        records: records(),
        directory: f.directory,
        run,
      }),
      /Interrupted/,
    );
    const body = api.writes.find(
      (value) => value.path.endsWith("/releases") && value.method === "POST",
    ).body;
    assert.ok(body.draft);
    assert.equal(promoted.size, 1);
    const assetBytes = new Map(),
      assets = [...api.uploads].map(([name, bytes], i) => {
        assetBytes.set(i + 1, bytes);
        return { id: i + 1, name };
      }),
      resumed = fakeApi(p, {
        release: {
          ...body,
          id: 7,
          upload_url: "https://uploads.github.com/example/assets{?name,label}",
        },
        assets,
        assetBytes,
        versions: (path) =>
          path.includes("orvyn-web/")
            ? [
                {
                  name: digest,
                  metadata: { container: { tags: [p.imageTag] } },
                },
              ]
            : [],
      }),
      commands = [];
    fail = false;
    await publish({
      api: resumed,
      plan: p,
      commit,
      records: records(),
      directory: f.directory,
      run: async (command, args) => {
        commands.push(args);
        return run(command, args);
      },
    });
    assert.equal(resumed.uploads.size, 0);
    assert.ok(!commands.some((args) => args[0] === "sign-blob"));
    assert.ok(
      !commands.some(
        (args) =>
          args.includes("create") &&
          args.includes(p.images.web + ":" + p.imageTag),
      ),
    );
    assert.deepEqual(resumed.writes.at(-1).body, {
      draft: false,
      prerelease: false,
      make_latest: "true",
    });
  } finally {
    await f.dispose();
  }
});
test("publication rejects a moved remote tag before creating drafts or uploading assets", async () => {
  const f = await fixture(),
    p = plan(),
    api = fakeApi(p),
    base = api.request;
  api.request = (path, options) =>
    path.includes("/git/ref/tags/")
      ? Promise.resolve({ object: { type: "commit", sha: "f".repeat(40) } })
      : base(path, options);
  try {
    await assert.rejects(
      publish({
        api,
        plan: p,
        commit,
        records: records(),
        directory: f.directory,
        run: () => assert.fail("No image command should run"),
      }),
      /validated commit/,
    );
    assert.equal(api.writes.length, 0);
  } finally {
    await f.dispose();
  }
});
test("GitHub client scopes credentials to its API, distinguishes absence from denial and rejects unsafe destinations", async () => {
  const calls = [],
    server = createServer((req, res) => {
      calls.push(req.headers.authorization);
      if (req.url === "/absent") {
        res.writeHead(404);
        res.end();
      } else if (req.url === "/denied") {
        res.writeHead(403);
        res.end("sensitive-token");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = new GitHub({
      repository: "Example/Orvyn",
      token: "sensitive-token",
      base: `http://127.0.0.1:${server.address().port}`,
    });
    assert.deepEqual(await client.request("/ok"), { ok: true });
    assert.equal(await client.request("/absent", { missing: true }), null);
    await assert.rejects(
      client.request("/denied", { missing: true }),
      (error) =>
        !error.message.includes("sensitive-token") &&
        error.message.includes("403"),
    );
    await assert.rejects(
      client.request("https://elsewhere.invalid/"),
      /Untrusted/,
    );
    assert.ok(calls.every((value) => value === "Bearer sensitive-token"));
    assert.throws(
      () =>
        new GitHub({
          repository: "Example/Orvyn",
          token: "token",
          base: "http://elsewhere.invalid",
        }),
      /HTTPS/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
