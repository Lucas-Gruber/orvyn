import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const image =
  "node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54";
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "orvyn-volume-test-")),
    volume = "orvyn-permissions-test-" + randomUUID(),
    state = volume + "-state";
  const docker = async (args, ok = true) => {
    let result;
    try {
      result = await exec("docker", args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      result.code = 0;
    } catch (error) {
      if (ok) throw error;
      result = error;
    }
    return result;
  };
  try {
    await chmod(directory, 0o755);
    // Copy only these compiled, dependency-free modules. No deployment files or secrets.
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(directory, "server.js"),
      await readFile(
        new URL("../packages/shared/dist/server.js", import.meta.url),
      ),
    );
    await writeFile(
      join(directory, "helper.js"),
      (
        await readFile(
          new URL("../apps/api/dist/volume-permissions.js", import.meta.url),
          "utf8",
        )
      ).replace('"@orvyn/shared/server"', '"./server.js"'),
    );
    await writeFile(
      join(directory, "cli.js"),
      "import {runVolumePermissions} from './helper.js'; runVolumePermissions(process.argv.slice(2)).catch(()=>{process.exitCode=1})",
    );
    for (const name of ["package.json", "server.js", "helper.js", "cli.js"])
      await chmod(join(directory, name), 0o644);
    await docker(["volume", "create", volume]);
    await docker(["volume", "create", state]);
    const base = [
      "run",
      "--rm",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "-v",
      volume + ":/data",
      "-v",
      state + ":/state",
      "-v",
      directory + ":/code:ro",
      "-w",
      "/code",
    ];
    const root = async (code) =>
      (
        await docker([
          ...base,
          "--user=0:0",
          "--cap-add=CHOWN",
          "--cap-add=FOWNER",
          "--cap-add=DAC_OVERRIDE",
          "--cap-add=FSETID", // Fixture provisioning emulates kubelet setting the SGID boundary.
          image,
          "node",
          "--input-type=module",
          "-e",
          code,
        ])
      ).stdout;
    await root(
      "import{chmod}from'node:fs/promises';await chmod('/data',0o755);await chmod('/state',0o1777)",
    );
    const phase = async (
      mode,
      {
        uid = 1000,
        gid = uid,
        fsGroup,
        role = "attachments",
        strategy = "auto",
        recursive = "onRootMismatch",
        caps = true,
        privateRoot,
        key = role,
      } = {},
    ) => {
      const repair = mode === "repair",
        args = [
          mode,
          "--path",
          "/data",
          "--uid",
          String(uid),
          "--gid",
          String(gid),
          "--role",
          role,
          "--component",
          "fixture",
          "--strategy",
          strategy,
          "--recursive",
          recursive,
          "--state-dir",
          "/state",
          "--state-key",
          key,
        ];
      if (fsGroup) args.push("--fs-group", String(fsGroup));
      if (privateRoot) args.push("--private-root", privateRoot);
      const result = await docker(
        [
          ...base,
          "--user=" + (repair ? "0:0" : uid + ":" + gid),
          ...(fsGroup ? ["--group-add=" + fsGroup] : []),
          ...(repair
            ? [
                "--cap-add=FOWNER",
                "--cap-add=DAC_OVERRIDE",
                ...(caps ? ["--cap-add=CHOWN"] : []),
              ]
            : []),
          image,
          "node",
          "cli.js",
          ...args,
        ],
        false,
      );
      const output = result.stdout + result.stderr;
      const logs = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const log of logs) {
        assert.equal(log.component, "volume-fixture");
        assert.equal(log.mountPath, "/data");
        assert.equal(log.expectedUid, uid);
        assert.ok(!output.includes("secret-file-content"));
        assert.ok(!output.includes("hidden-filename"));
        assert.equal("stack" in log, false);
      }
      return { code: Number(result.code), logs, output };
    };
    await run({ phase, root });
  } finally {
    await docker(["volume", "rm", volume, state]);
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [role, critical, uid] of [
  ["postgresql", "pgdata", 999],
  ["valkey", "appendonlydir", 999],
  ["attachments", "orvyn-objects/staging", 1000],
  ["storage", "filerldb2", 1000],
  ["backups", "fixture/postgresql", 999],
])
  test(`persistent ${role}: repair root:root 0755, preserve data, verify real UID and skip unchanged restart`, () =>
    fixture(async ({ phase, root }) => {
      await root(
        `import{mkdir,writeFile}from'node:fs/promises';await mkdir('/data/${critical}',{recursive:true});await writeFile('/data/${critical}/hidden-filename','secret-file-content')`,
      );
      const options = {
        uid,
        role,
        ...(role === "backups" ? { privateRoot: critical } : {}),
      };
      assert.equal(
        (await phase("probe", options)).logs.at(-1).event,
        "permissions.repair_needed",
      );
      const repair = await phase("repair", options);
      assert.equal(repair.code, 0, repair.output);
      assert.equal(repair.logs.at(-1).event, "permissions.repaired");
      assert.ok(repair.logs.at(-1).changedEntries > 0);
      const verify = await phase("verify", options);
      assert.equal(verify.code, 0, verify.output);
      const snapshot =
        "import{stat,readFile,readdir}from'node:fs/promises';const s=await stat('/data/" +
        critical +
        "/hidden-filename');console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777,ctime:s.ctimeMs,bytes:await readFile('/data/" +
        critical +
        "/hidden-filename','utf8'),root:await readdir('/data')}))";
      const before = JSON.parse(await root(snapshot));
      assert.equal(before.uid, uid);
      assert.equal(before.bytes, "secret-file-content");
      assert.ok(!before.root.some((name) => name.startsWith(".orvyn-")));
      if (["attachments", "backups"].includes(role))
        assert.equal(before.mode, 0o600);
      assert.equal((await phase("probe", options)).code, 0);
      const again = await phase("repair", options);
      assert.equal(again.logs.at(-1).event, "permissions.repair_skipped");
      assert.equal(again.logs.at(-1).visitedEntries, 0);
      assert.deepEqual(JSON.parse(await root(snapshot)), before);
    }));

test("fsGroup works without root and retains kubelet's shared mount boundary", () =>
  fixture(async ({ phase, root }) => {
    await root(
      "import{chown,chmod,mkdir,writeFile}from'node:fs/promises';await chown('/data',0,1234);await chmod('/data',0o2770);await mkdir('/data/orvyn-objects/staging',{recursive:true});for(const p of ['/data/orvyn-objects','/data/orvyn-objects/staging']){await chown(p,2000,1234);await chmod(p,0o2770)}await writeFile('/data/orvyn-objects/staging/file','secret-file-content',{mode:0o660});await chown('/data/orvyn-objects/staging/file',2000,1234)",
    );
    const result = await phase("verify", {
      uid: 2000,
      gid: 2001,
      fsGroup: 1234,
      strategy: "fsGroup",
    });
    assert.equal(result.code, 0, result.output);
    const state = JSON.parse(
      await root(
        "import{stat}from'node:fs/promises';const root=await stat('/data'),dir=await stat('/data/orvyn-objects'),file=await stat('/data/orvyn-objects/staging/file');console.log(JSON.stringify({root:[root.uid,root.gid,root.mode&0o7777],dir:dir.mode&0o7777,file:file.mode&0o777}))",
      ),
    );
    assert.deepEqual(state, {
      root: [0, 1234, 0o2770],
      dir: 0o700,
      file: 0o600,
    });
  }));

test("correct ownership with a read-only critical directory is prepared without a repair loop", () =>
  fixture(async ({ phase, root }) => {
    await root(
      "import{mkdir,chown,chmod,writeFile}from'node:fs/promises';await chown('/data',1000,1000);await mkdir('/data/orvyn-objects/staging',{recursive:true});for(const p of ['/data/orvyn-objects','/data/orvyn-objects/staging']){await chown(p,1000,1000);await chmod(p,0o550)}await chmod('/data/orvyn-objects',0o750);await writeFile('/data/orvyn-objects/staging/hidden-filename','secret-file-content',{mode:0o440});await chown('/data/orvyn-objects/staging/hidden-filename',1000,1000)",
    );
    const probe = await phase("probe");
    assert.equal(probe.code, 0, probe.output);
    assert.equal(probe.logs.at(-1).event, "permissions.probe_ready");
    assert.equal(
      (await phase("repair")).logs.at(-1).event,
      "permissions.repair_skipped",
    );
    assert.equal((await phase("verify")).code, 0);
    assert.deepEqual(
      JSON.parse(
        await root(
          "import{stat}from'node:fs/promises';console.log(JSON.stringify([(await stat('/data/orvyn-objects')).mode&0o777,(await stat('/data/orvyn-objects/staging')).mode&0o777,(await stat('/data/orvyn-objects/staging/hidden-filename')).mode&0o777]))",
        ),
      ),
      [0o700, 0o700, 0o600],
    );
  }));

test("denied chown fails real nonroot verification and recovers after server-side correction", () =>
  fixture(async ({ phase, root }) => {
    const options = { caps: false };
    assert.equal((await phase("probe", options)).code, 0);
    const denied = await phase("repair", options);
    assert.equal(denied.code, 0);
    assert.equal(denied.logs.at(-1).event, "permissions.repair_denied");
    assert.equal(denied.logs.at(-1).code, "EPERM");
    assert.match(denied.logs.at(-1).action, /storage|server|NFS/i);
    const failed = await phase("verify", options);
    assert.equal(failed.code, 1);
    assert.equal(failed.logs.at(-1).code, "EACCES");
    await root(
      "import{chown}from'node:fs/promises';await chown('/data',1000,1000)",
    );
    assert.equal((await phase("verify", options)).code, 0);
  }));

test("partially prepared private modes persist intent and repair unreadable descendants", () =>
  fixture(async ({ phase, root }) => {
    await root(
      "import{mkdir,chown,chmod,writeFile}from'node:fs/promises';await chown('/data',1000,1000);await mkdir('/data/orvyn-objects/staging',{recursive:true});for(const p of ['/data/orvyn-objects','/data/orvyn-objects/staging']){await chown(p,1000,1000);await chmod(p,0o770)}await writeFile('/data/orvyn-objects/staging/hidden-filename','secret-file-content',{mode:0o000});await chown('/data/orvyn-objects/staging/hidden-filename',1000,1000)",
    );
    const probe = await phase("probe");
    assert.equal(probe.code, 0);
    assert.equal(probe.logs.at(-1).event, "permissions.repair_needed");
    assert.equal(
      JSON.parse(
        await root(
          "import{readdir}from'node:fs/promises';console.log(JSON.stringify((await readdir('/data')).some(n=>n.startsWith('.orvyn-permissions-incomplete-'))))",
        ),
      ),
      true,
    );
    const repair = await phase("repair");
    assert.equal(repair.code, 0, repair.output);
    assert.ok(repair.logs.at(-1).visitedEntries > 2);
    const verified = await phase("verify");
    assert.equal(verified.code, 0, verified.output);
    assert.equal(
      JSON.parse(
        await root(
          "import{stat}from'node:fs/promises';console.log(JSON.stringify((await stat('/data/orvyn-objects/staging/hidden-filename')).mode&0o777))",
        ),
      ),
      0o600,
    );
  }));

test("recursive repair cannot follow symlinks or hardlinks outside the data volume", () =>
  fixture(async ({ phase, root }) => {
    await root(
      "import{writeFile,symlink,link,mkdir}from'node:fs/promises';await writeFile('/state/outside','secret-file-content',{mode:0o644});await symlink('/state','/data/escape');await mkdir('/data/existing');await writeFile('/data/existing/one','secret-file-content');await link('/data/existing/one','/data/existing/two')",
    );
    const result = await phase("repair", {
      strategy: "initContainer",
      recursive: "always",
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.logs.at(-1).skippedEntries, 3);
    assert.deepEqual(
      JSON.parse(
        await root(
          "import{stat}from'node:fs/promises';console.log(JSON.stringify([(await stat('/state/outside')).uid,(await stat('/data/existing/one')).uid]))",
        ),
      ),
      [0, 0],
    );
  }));

test("interrupted ownership repair resumes descendants after the root is already correct", () =>
  fixture(async ({ phase, root }) => {
    await root(
      "import{createHash}from'node:crypto';import{writeFile,mkdir,chown}from'node:fs/promises';const signature=createHash('sha256').update(JSON.stringify({version:1,root:'/data',role:'attachments',uid:1000,gid:1000,fsGroup:null,privateRoot:null})).digest('hex');await mkdir('/data/orvyn-objects/staging',{recursive:true});await writeFile('/data/orvyn-objects/staging/hidden-filename','secret-file-content');await writeFile('/data/.orvyn-permissions-incomplete-'+signature,JSON.stringify({version:1,signature}),{mode:0o600});await chown('/data',1000,1000);await chown('/data/.orvyn-permissions-incomplete-'+signature,1000,1000)",
    );
    await phase("probe");
    const repair = await phase("repair");
    assert.equal(repair.code, 0, repair.output);
    assert.ok(repair.logs.at(-1).visitedEntries > 2);
    assert.equal((await phase("verify")).code, 0);
  }));

test("two pods prepare one RWX mount concurrently with a stable shared fsGroup", () =>
  fixture(async ({ phase, root }) => {
    await root(
      "import{mkdir,writeFile}from'node:fs/promises';await mkdir('/data/orvyn-objects/staging',{recursive:true});await writeFile('/data/orvyn-objects/staging/hidden-filename','secret-file-content')",
    );
    const options = {
      strategy: "initContainer",
      uid: 2000,
      gid: 2001,
      fsGroup: 1234,
    };
    const results = await Promise.all([
      phase("repair", { ...options, key: "api" }),
      phase("repair", { ...options, key: "worker" }),
    ]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    assert.equal((await phase("verify", options)).code, 0);
    assert.deepEqual(
      JSON.parse(
        await root(
          "import{stat}from'node:fs/promises';const s=await stat('/data');console.log(JSON.stringify([s.uid,s.gid]))",
        ),
      ),
      [2000, 1234],
    );
  }));
