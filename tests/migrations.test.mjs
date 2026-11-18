import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "./helpers.mjs";
import { migrate, migrations } from "../apps/api/dist/migrations.js";
import { documentSchemaVersion } from "../packages/editor/dist/index.js";
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
    const oldSpace = (
      await db.query(
        "INSERT INTO spaces(owner_id,name) VALUES($1,'Legacy space') RETURNING id",
        [account.rows[0].id],
      )
    ).rows[0].id;
    const oldPage = (
      await db.query(
        "INSERT INTO pages(space_id,title,document,version) VALUES($1,'Legacy page',$2,7) RETURNING id",
        [
          oldSpace,
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                text: "Preserved legacy knowledge <script> stays text",
              },
            ],
          },
        ],
      )
    ).rows[0].id;
    const linkedLegacy = (
      await db.query(
        "INSERT INTO pages(space_id,title,document) VALUES($1,'Legacy reference',$2) RETURNING id",
        [
          oldSpace,
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Existing link",
                    marks: [
                      {
                        type: "link",
                        attrs: { href: "/?page=" + oldPage, target: "_self" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      )
    ).rows[0].id;
    await migrate(db, 33);
    const beforeSearch = (
      await db.query(
        "SELECT version,updated_at::text AS modified FROM pages WHERE id=$1",
        [oldPage],
      )
    ).rows[0];
    await Promise.all([migrate(db), migrate(db)]);
    assert.deepEqual(
      (
        await db.query(
          "SELECT version,updated_at::text AS modified FROM pages WHERE id=$1",
          [oldPage],
        )
      ).rows[0],
      beforeSearch,
    );
    const indexed = (
      await db.query(
        "SELECT body_text,search_vector@@orvyn_search_query('knowledge') AS matches FROM page_search WHERE page_id=$1",
        [oldPage],
      )
    ).rows[0];
    assert.equal(indexed.matches, true);
    assert.ok(
      indexed.body_text.includes(
        "Preserved legacy knowledge <script> stays text",
      ),
    );
    assert.equal(
      (
        await db.query(
          "SELECT source_id FROM page_references WHERE target_id=$1",
          [oldPage],
        )
      ).rows[0].source_id,
      linkedLegacy,
    );
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
    const migrated = (
      await db.query(
        "SELECT document,version,created_by,document_schema_version FROM pages WHERE id=$1",
        [oldPage],
      )
    ).rows[0];
    assert.deepEqual(migrated.document, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Preserved legacy knowledge <script> stays text",
            },
          ],
        },
      ],
    });
    assert.equal(migrated.version, 7);
    assert.equal(migrated.created_by, account.rows[0].id);
    assert.equal(migrated.document_schema_version, 1);
    const created = (
      await db.query(
        "INSERT INTO pages(space_id,title,created_by,last_edited_by) VALUES($1,'New page',$2,$2) RETURNING document_schema_version",
        [oldSpace, account.rows[0].id],
      )
    ).rows[0];
    assert.equal(created.document_schema_version, documentSchemaVersion);
    assert.deepEqual(
      (
        await db.query(
          "SELECT document FROM page_revisions WHERE page_id=$1 AND version=7",
          [oldPage],
        )
      ).rows[0].document,
      migrated.document,
    );
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
