import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Pool, request, sessionCookie } from "./helpers.mjs";

test(
  "Helm PostgreSQL snapshots: actual archives, safe retention, isolated restore and failure handling",
  { timeout: 180000 },
  async (t) => {
    const url = new URL(process.env.DATABASE_URL);
    const redactions = [url.password, decodeURIComponent(url.password)].filter(
      Boolean,
    );
    const redact = (value) =>
      redactions.reduce(
        (text, secret) => text.replaceAll(secret, "[redacted]"),
        String(value),
      );
    function run(command, args, env = process.env) {
      return new Promise((resolve) => {
        execFile(
          command,
          args,
          { env, maxBuffer: 2 * 1024 * 1024, timeout: 60000 },
          (error, stdout, stderr) => {
            resolve({
              code: error?.code || 0,
              stdout: redact(stdout),
              stderr: redact(stderr),
              containsCredentials: redactions.some(
                (secret) => stdout.includes(secret) || stderr.includes(secret),
              ),
            });
          },
        );
      });
    }
    const compose = await run("docker", [
      "compose",
      "--env-file",
      ".env",
      "-f",
      "infrastructure/compose/compose.yaml",
      "ps",
      "-q",
      "postgres",
    ]);
    assert.equal(compose.code, 0, compose.stderr);
    const container = compose.stdout.trim();
    assert.match(container, /^[a-f0-9]+$/);
    const directory = "/tmp/orvyn-backup-test-" + randomUUID();
    const snapshots = directory + "/snapshots";
    const db = new Pool({ connectionString: process.env.DATABASE_URL });
    const restoreNames = [];
    const docker = (args) => run("docker", ["exec", container, ...args]);
    const connection = {
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      DATABASE_URL: "",
      PGCONNECT_TIMEOUT: "2",
      ORVYN_BACKUP_DIRECTORY: snapshots,
      ORVYN_BACKUP_RETENTION_COUNT: "2",
      ORVYN_RESTORE_BACKUP: "",
      ORVYN_RESTORE_DATABASE: "",
    };
    const external = new URL(url);
    external.hostname = "127.0.0.1";
    external.port = "5432";
    external.searchParams.set(
      "application_name",
      "Orvyn recovery fixture & query",
    );
    external.searchParams.set("dbname", connection.PGDATABASE);
    async function job(script, overrides = {}, fileLimit = false) {
      const values = { ...connection, ...overrides };
      const result = await run(
        "docker",
        [
          "exec",
          "--user",
          "999:999",
          ...Object.keys(values).flatMap((name) => ["-e", name]),
          container,
          ...(fileLimit
            ? [
                "bash",
                "-c",
                'ulimit -f 1; exec bash "$1"',
                "_",
                `${directory}/scripts/${script}-postgresql.sh`,
              ]
            : ["bash", `${directory}/scripts/${script}-postgresql.sh`]),
        ],
        { ...process.env, ...values },
      );
      assert.equal(
        result.containsCredentials,
        false,
        "Job output must not contain connection credentials",
      );
      return result;
    }
    async function completed() {
      const result = await docker([
        "bash",
        "-c",
        'for path in "$1"/postgresql-*; do [[ -d "$path" ]] && basename "$path"; done',
        "_",
        snapshots,
      ]);
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim().split("\n").filter(Boolean);
    }
    const restoreName = () => {
      const name = "orvyn_restore_" + randomUUID().replaceAll("-", "");
      restoreNames.push(name);
      return name;
    };
    const exists = async (name) =>
      (
        await db.query(
          "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1) AS found",
          [name],
        )
      ).rows[0].found;
    let sourcePage, selected;
    try {
      assert.equal(
        (await docker(["mkdir", "-m", "700", "-p", directory + "/scripts"]))
          .code,
        0,
      );
      for (const file of [
        "postgresql-common.sh",
        "backup-postgresql.sh",
        "restore-postgresql.sh",
      ])
        assert.equal(
          (
            await run("docker", [
              "cp",
              `infrastructure/helm/orvyn/files/${file}`,
              `${container}:${directory}/scripts/${file}`,
            ])
          ).code,
          0,
        );
      assert.equal(
        (await docker(["chown", "-R", "999:999", directory])).code,
        0,
      );
      const registered = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      });
      assert.equal(registered.response.status, 201);
      const cookie = sessionCookie(registered.response);
      const space = (
        await request("spaces", {
          method: "POST",
          cookie,
          body: { name: "Scheduled database recovery" },
        })
      ).data;
      sourcePage = (
        await request(`spaces/${space.id}/pages`, {
          method: "POST",
          cookie,
          body: { title: "Recover the real private document" },
        })
      ).data;

      await t.test(
        "non-root backup produces a verified private archive; internal and URI connections work",
        async () => {
          const first = await job("backup");
          assert.equal(first.code, 0, first.stderr);
          const firstName = (await completed())[0];
          assert.match(
            firstName,
            /^postgresql-[0-9]{8}T[0-9]{15}Z-[A-Za-z0-9]{8}$/,
          );
          const permission = await docker([
            "stat",
            "-c",
            "%a",
            snapshots,
            `${snapshots}/${firstName}`,
            `${snapshots}/${firstName}/database.dump`,
          ]);
          assert.deepEqual(permission.stdout.trim().split("\n"), [
            "700",
            "700",
            "600",
          ]);
          const checksum = await docker([
            "bash",
            "-c",
            'cd -- "$1" && sha256sum --check --strict SHA256SUMS',
            "_",
            `${snapshots}/${firstName}`,
          ]);
          assert.equal(checksum.code, 0, checksum.stderr);
          // An unrelated directory must survive retention, even if its name looks managed.
          const unmanaged =
            snapshots + "/postgresql-20000101T000000000000000Z-Unmanage";
          assert.equal((await docker(["mkdir", unmanaged])).code, 0);
          for (let i = 0; i < 2; i++) {
            const result = await job("backup", {
              DATABASE_URL: external.toString(),
            });
            assert.equal(result.code, 0, result.stderr);
          }
          const all = await completed();
          assert.equal(all.length, 3);
          assert.ok(!all.includes(firstName));
          assert.equal((await docker(["test", "-d", unmanaged])).code, 0);
          selected = all.filter((name) => name !== basename(unmanaged)).at(-1);
        },
      );

      await t.test(
        "connection failure preserves snapshots and removes its partial output",
        async () => {
          const before = await completed();
          const unavailable = new URL(external);
          unavailable.port = "1";
          const result = await job("backup", {
            DATABASE_URL: unavailable.toString(),
          });
          assert.notEqual(result.code, 0);
          assert.match(result.stderr, /Cannot connect/);
          assert.deepEqual(await completed(), before);
          const partialDump = await job(
            "backup",
            { DATABASE_URL: external.toString() },
            true,
          );
          assert.notEqual(partialDump.code, 0);
          assert.match(partialDump.stderr, /dump failed/);
          assert.deepEqual(await completed(), before);
          const partial = await docker([
            "find",
            snapshots,
            "-maxdepth",
            "1",
            "-name",
            ".pending-*",
            "-print",
          ]);
          assert.equal(partial.stdout.trim(), "");
        },
      );

      await t.test(
        "manual jobs cannot overlap a backup or a restore using the same archive directory",
        async () => {
          const holder = execFile("docker", [
            "exec",
            "-i",
            container,
            "bash",
            "-c",
            'exec 9>"$1/.lock"; flock 9; printf "locked\\n"; read -r release',
            "_",
            snapshots,
          ]);
          try {
            assert.match(
              String((await once(holder.stdout, "data"))[0]),
              /locked/,
            );
            const result = await job("backup");
            assert.notEqual(result.code, 0);
            assert.match(result.stderr, /Another database/);
            const restored = await job("restore", {
              ORVYN_RESTORE_BACKUP: selected,
              ORVYN_RESTORE_DATABASE: restoreName(),
            });
            assert.notEqual(restored.code, 0);
            assert.match(restored.stderr, /Another database/);
          } finally {
            holder.stdin.end("release\n");
            await once(holder, "exit");
          }
        },
      );

      await t.test(
        "URI restore creates an independent database and refuses an existing target",
        async () => {
          const name = restoreName();
          const overrides = {
            DATABASE_URL: external.toString(),
            ORVYN_RESTORE_BACKUP: selected,
            ORVYN_RESTORE_DATABASE: name,
          };
          const result = await job("restore", overrides);
          assert.equal(result.code, 0, result.stderr);
          const recoveredUrl = new URL(process.env.DATABASE_URL);
          recoveredUrl.pathname = "/" + name;
          const recovered = new Pool({
            connectionString: recoveredUrl.toString(),
          });
          try {
            assert.equal(
              (
                await recovered.query("SELECT title FROM pages WHERE id=$1", [
                  sourcePage.id,
                ])
              ).rows[0].title,
              sourcePage.title,
            );
            await recovered.query("CREATE TABLE restore_sentinel (id integer)");
            const repeat = await job("restore", overrides);
            assert.notEqual(repeat.code, 0);
            assert.ok(
              (
                await recovered.query(
                  "SELECT to_regclass('restore_sentinel') AS sentinel",
                )
              ).rows[0].sentinel,
            );
          } finally {
            await recovered.end();
          }
          const unsafe = await job("restore", {
            ORVYN_RESTORE_BACKUP: selected,
            ORVYN_RESTORE_DATABASE: connection.PGDATABASE,
          });
          assert.notEqual(unsafe.code, 0);
          assert.match(unsafe.stderr, /orvyn_restore_/);
        },
      );

      await t.test(
        "a truncated archive with refreshed checksums still fails restore and cleans only its new database",
        async () => {
          const corrupt = "postgresql-20990101T000000000000000Z-Truncate";
          assert.equal(
            (
              await docker([
                "cp",
                "-a",
                `${snapshots}/${selected}`,
                `${snapshots}/${corrupt}`,
              ])
            ).code,
            0,
          );
          assert.equal(
            (
              await docker([
                "bash",
                "-c",
                'cd -- "$1"; truncate -s -64 database.dump; sha256sum database.dump metadata >SHA256SUMS',
                "_",
                `${snapshots}/${corrupt}`,
              ])
            ).code,
            0,
          );
          const target = restoreName();
          const result = await job("restore", {
            ORVYN_RESTORE_BACKUP: corrupt,
            ORVYN_RESTORE_DATABASE: target,
          });
          assert.notEqual(result.code, 0);
          assert.equal(await exists(target), false);
          assert.equal(
            (
              await db.query("SELECT title FROM pages WHERE id=$1", [
                sourcePage.id,
              ])
            ).rows[0].title,
            sourcePage.title,
          );
        },
      );

      await t.test(
        "tampered content and extra manifest paths are refused before creating a database",
        async () => {
          const forged = "postgresql-20990101T000000000000000Z-Manifest";
          assert.equal(
            (
              await docker([
                "cp",
                "-a",
                `${snapshots}/${selected}`,
                `${snapshots}/${forged}`,
              ])
            ).code,
            0,
          );
          assert.equal(
            (
              await docker([
                "bash",
                "-c",
                'printf "%064d  ../../outside" 0 >>"$1/SHA256SUMS"',
                "_",
                `${snapshots}/${forged}`,
              ])
            ).code,
            0,
          );
          let target = restoreName();
          let result = await job("restore", {
            ORVYN_RESTORE_BACKUP: forged,
            ORVYN_RESTORE_DATABASE: target,
          });
          assert.notEqual(result.code, 0);
          assert.equal(await exists(target), false);
          assert.equal(
            (
              await docker([
                "bash",
                "-c",
                'printf tampered >>"$1/database.dump"',
                "_",
                `${snapshots}/${selected}`,
              ])
            ).code,
            0,
          );
          target = restoreName();
          result = await job("restore", {
            ORVYN_RESTORE_BACKUP: selected,
            ORVYN_RESTORE_DATABASE: target,
          });
          assert.notEqual(result.code, 0);
          assert.equal(await exists(target), false);
          assert.match(result.stderr, /integrity verification failed/);
        },
      );
    } finally {
      for (const name of restoreNames)
        await db.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
      await db.end();
      await docker(["rm", "-rf", "--", directory]);
    }
  },
);
