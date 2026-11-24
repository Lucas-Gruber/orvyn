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
  digest = "sha256:" + "b".repeat(64);
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
        if (args.includes("--format")) return digest;
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
    return args.includes("--format") ? digest : "";
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
    if (args.includes("--format")) {
      assert.ok(promoted.has(args.at(-1)));
      return digest;
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
