import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "./helpers.mjs";
const require = createRequire(import.meta.url),
  { migrate, migrations } = require("../apps/api/dist/migrations.js");
test("migrations install, upgrade existing records, serialize and roll back failed schema changes", async () => {
  const root = new Pool({ connectionString: process.env.DATABASE_URL });
  const name = "orvyn_test_" + randomBytes(8).toString("hex");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + name;
  let db;
  try {
    await root.query("CREATE DATABASE " + name);
    db = new Pool({ connectionString: url.toString() });
    await migrate(db, 1);
    const account = await db.query(
      "INSERT INTO users(email,password_hash) VALUES('upgrade@example.test','existing') RETURNING id",
    );
    await Promise.all([migrate(db), migrate(db)]);
    const row = (
      await db.query(
        "SELECT email,password_hash,email_verified FROM users WHERE id=$1",
        [account.rows[0].id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      email: "upgrade@example.test",
      password_hash: "existing",
      email_verified: false,
    });
    assert.deepEqual(
      (
        await db.query("SELECT version FROM schema_migrations ORDER BY version")
      ).rows.map((r) => r.version),
      migrations.map((m) => m.version),
    );
    migrations.push({
      version: 99,
      sql: "CREATE TABLE must_rollback(id integer); SELECT * FROM table_that_does_not_exist;",
    });
    try {
      await assert.rejects(migrate(db));
    } finally {
      migrations.pop();
    }
    assert.equal(
      (await db.query("SELECT to_regclass('must_rollback') AS name")).rows[0]
        .name,
      null,
    );
    assert.equal(
      (await db.query("SELECT * FROM schema_migrations WHERE version=99"))
        .rowCount,
      0,
    );
    await db.query("INSERT INTO schema_migrations VALUES(999)");
    await assert.rejects(migrate(db), /newer/);
  } finally {
    if (db) await db.end();
    await root.query("DROP DATABASE IF EXISTS " + name);
    await root.end();
  }
});
