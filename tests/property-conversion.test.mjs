import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, Pool } from "./helpers.mjs";
import { convertPropertyCell } from "../apps/api/dist/databases/conversion-values.js";
import {
  decodeConversionToken,
  signConversionToken,
} from "../apps/api/dist/databases/conversions.js";

import { conversionFixture as fixture } from "./property-conversion-fixture.mjs";

test("scalar conversion rejects ambiguous numbers and invalid dates, keeps finite values and distinguishes missing/null/false/zero", () => {
  const property = {
    id: randomUUID(),
    name: "Value",
    type: "Text",
    position: 0,
    config: {},
  };
  for (const [value, type, expected] of [
    [" 0012 ", "Number", 12],
    ["-1.5e2", "Number", -150],
    ["0x10", "Number", null],
    ["1,000", "Number", null],
    ["1e309", "Number", null],
    ["", "Number", null],
    [false, "Number", 0],
    [0, "Checkbox", false],
    [2, "Checkbox", null],
    ["ja", "Checkbox", true],
    ["nein", "Checkbox", false],
    ["2026-02-30", "Date", null],
    ["2026-02-28", "Date", "2026-02-28"],
    ["https://example.test", "URL", "https://example.test"],
    ["javascript:alert(1)", "URL", null],
    ["invalid", "Email", null],
    [false, "Text", "false"],
    [0, "Text", "0"],
  ])
    assert.deepEqual(
      convertPropertyCell({ present: true, value }, property, type),
      { present: true, value: expected },
      String(value) + " → " + type,
    );
  assert.deepEqual(
    convertPropertyCell({ present: false, value: null }, property, "Text"),
    { present: false, value: null },
  );
});

test("owner conversion previews all rows without writes, requires explicit empty-value acknowledgement, retains originals and retries idempotently", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      before = await f.stored(),
      meta = await f.get();
    for (const actor of [f.editor, f.viewer]) {
      assert.equal(
        (await f.preview({ toType: "Number" }, actor)).response.status,
        404,
      );
      assert.equal((await f.history(actor)).response.status, 404);
    }
    const r = await f.preview({ toType: "Number" });
    assert.equal(r.response.status, 200);
    assert.equal(r.data.totalRecords, 9);
    assert.equal(r.data.clearedValues, 2);
    assert.equal(r.data.archivedRecords, 1);
    assert.deepEqual(await f.stored(), before);
    assert.equal((await f.get()).schemaVersion, meta.schemaVersion);
    assert.equal((await f.apply(r.data, {}, f.editor)).response.status, 404);
    assert.equal(
      (await f.apply(r.data, { acceptEmpty: false })).response.status,
      400,
    );
    assert.deepEqual((await f.history()).data, []);
    assert.deepEqual(await f.stored(), before);
    const requestId = randomUUID();
    const applied = await f.apply(r.data, { requestId });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.data));
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Number",
    );
    assert.equal((await f.get()).schemaVersion, meta.schemaVersion + 1);
    const after = await f.stored(),
      find = (index) =>
        after.find((row) => row.page_id === f.rows[index].pageId);
    assert.equal(find(0).values[f.notes.id], 12);
    assert.equal(find(1).values[f.notes.id], null);
    assert.equal(find(5).values[f.notes.id], 8);
    assert.equal(find(6).values[f.notes.id], 9);
    assert.equal(find(8).values[f.notes.id], -1.5);
    assert.equal(Object.hasOwn(find(4).values, f.notes.id), false);
    assert.equal(find(3).version, f.rows[3].version);
    assert.equal(find(0).values[f.other.id], "Keep this independent value");
    const retry = await f.apply(r.data, { requestId });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.data.id, applied.data.id);
    assert.equal(retry.data.alreadyApplied, true);
    assert.deepEqual(await f.stored(), after);
    assert.equal((await f.history()).data.length, 1);
    const backups = (
      await db.query(
        "SELECT original_present,original_value FROM database_property_change_values WHERE change_id=$1 AND page_id=$2",
        [applied.data.id, f.rows[0].pageId],
      )
    ).rows[0];
    assert.equal(backups.original_value, "0012");
    const [encoded, signature] = r.data.previewToken.split(".");
    const tampered =
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(encoded, "base64url")),
          toType: "Text",
        }),
      ).toString("base64url") +
      "." +
      signature;
    assert.equal(
      (await f.apply({ previewToken: tampered })).response.status,
      400,
    );
    assert.equal(
      (await f.apply({ previewToken: r.data.previewToken + "." })).response
        .status,
      400,
    );
  } finally {
    await db.end();
  }
});

test("conversion previews bind record, schema and view revisions and cannot be applied to a different property", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    let preview = (await f.preview({ toType: "Number" })).data;
    await f.patch(f.rows[0], "22");
    assert.equal((await f.apply(preview)).response.status, 409);
    preview = (await f.preview({ toType: "Number" })).data;
    const view = (await f.get()).views.find((v) => v.type === "Table");
    assert.equal(
      (
        await request(f.path + "/views/" + view.id, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            name: view.name,
            type: view.type,
            version: view.version,
            config: { ...view.config, propertyWidths: { [f.notes.id]: 300 } },
          },
        })
      ).response.status,
      200,
    );
    assert.equal((await f.apply(preview)).response.status, 409);
    preview = (await f.preview({ toType: "Number" })).data;
    await f.add("An independent field", "Text");
    assert.equal((await f.apply(preview)).response.status, 409);
    preview = (await f.preview({ toType: "Number" })).data;
    const wrongField = await request(
      `${f.path}/properties/${f.other.id}/convert`,
      {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          previewToken: preview.previewToken,
          requestId: randomUUID(),
          confirm: true,
          acceptEmpty: true,
        },
      },
    );
    assert.equal(wrongField.response.status, 400);
    assert.deepEqual((await f.history()).data, []);
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Text",
    );
  } finally {
    await db.end();
  }
});

test("reviewing originals restores exact unchanged values while newer edits and new records convert from their current values", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      preview = (await f.preview({ toType: "Number" })).data;
    const applied = await f.apply(preview);
    assert.equal(applied.response.status, 200, JSON.stringify(applied.data));
    await f.patch(f.rows[0], 22);
    const fresh = await f.make("A newer estimate", 7);
    const restoredPreview = await f.preview({ historyId: applied.data.id });
    assert.equal(restoredPreview.response.status, 200);
    assert.equal(restoredPreview.data.toType, "Text");
    assert.equal(
      restoredPreview.data.samples.find((row) => row.id === f.rows[0].pageId)
        .after,
      "22",
    );
    assert.equal(
      restoredPreview.data.samples.find((row) => row.id === f.rows[1].pageId)
        .after,
      "two",
    );
    const restored = await f.apply(restoredPreview.data);
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
    const rows = await f.stored(),
      find = (index) =>
        rows.find((row) => row.page_id === f.rows[index].pageId);
    assert.equal(find(0).values[f.notes.id], "22");
    assert.equal(find(1).values[f.notes.id], "two");
    assert.equal(find(2).values[f.notes.id], "");
    assert.equal(find(3).values[f.notes.id], null);
    assert.equal(Object.hasOwn(find(4).values, f.notes.id), false);
    assert.equal(find(7).values[f.notes.id], "1e309");
    assert.equal(
      rows.find((row) => row.page_id === fresh.pageId).values[f.notes.id],
      "7",
    );
    assert.equal((await f.history()).data[0].restoredFrom, applied.data.id);
    const missing = (
      await db.query(
        "SELECT original_present FROM database_property_change_values WHERE change_id=$1 AND page_id=$2",
        [applied.data.id, f.rows[4].pageId],
      )
    ).rows[0];
    assert.equal(missing.original_present, false);
  } finally {
    await db.end();
  }
});

test("conversion repairs field filters/calendar settings and width minimums while blocking incompatible local formulas", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    await f.patch(f.rows[0], "2026-12-17");
    let meta = await f.get(),
      table = meta.views.find((v) => v.type === "Table");
    await request(f.path + "/views/" + table.id, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        name: table.name,
        type: table.type,
        version: table.version,
        config: {
          ...table.config,
          filters: [
            { propertyId: f.notes.id, operator: "contains", value: "2026" },
          ],
          sorts: [{ propertyId: f.notes.id, direction: "asc" }],
          propertyWidths: { [f.notes.id]: 140 },
          propertyOrder: [f.notes.id],
        },
      },
    });
    const preview = (await f.preview({ toType: "Date" })).data;
    assert.ok(preview.affectedViews.some((v) => v.id === table.id));
    assert.equal((await f.apply(preview)).response.status, 200);
    meta = await f.get();
    table = meta.views.find((v) => v.id === table.id);
    assert.deepEqual(table.config.filters, []);
    assert.deepEqual(table.config.sorts, []);
    assert.equal(table.config.propertyWidths[f.notes.id], 160);
    assert.deepEqual(table.config.propertyOrder, [f.notes.id]);
    const calendar = (
      await request(f.path + "/views", {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          name: "Milestones",
          type: "Calendar",
          config: { dateProperty: f.notes.id },
        },
      })
    ).data;
    const toText = (await f.preview({ toType: "Text" })).data;
    assert.ok(
      toText.affectedViews.some(
        (v) => v.id === calendar.id && v.type === "Table",
      ),
    );
    assert.equal((await f.apply(toText)).response.status, 200);
    assert.equal(
      (await f.get()).views.find((v) => v.id === calendar.id).type,
      "Table",
    );
    await f.add("Dependent text", "Formula", { formula: 'prop("Estimate")' });
    assert.equal((await f.preview({ toType: "Number" })).response.status, 409);
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Text",
    );
    for (const toType of ["Relation", "Files", "Formula", "Select", "Title"])
      assert.equal((await f.preview({ toType })).response.status, 400);
  } finally {
    await db.end();
  }
});

test("interactive conversion caps the record set before changing any values or creating history", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      ids = Array.from({ length: 5001 }, () => randomUUID());
    await db.query(
      "INSERT INTO pages(id,space_id,parent_id,title,kind) SELECT id,$2,$3,'Large item','record' FROM unnest($1::uuid[]) id",
      [ids, f.space.id, f.database.id],
    );
    await db.query(
      "INSERT INTO database_records(page_id,database_id,values) SELECT id,$2,jsonb_build_object($3::text,'1') FROM unnest($1::uuid[]) id",
      [ids, f.database.id, f.notes.id],
    );
    assert.equal((await f.preview({ toType: "Number" })).response.status, 413);
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Text",
    );
    assert.deepEqual((await f.history()).data, []);
  } finally {
    await db.end();
  }
});

test("expired previews and a failure after schema/view changes leave values, revisions, search projections and history untouched", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let trigger = false;
  try {
    const f = await fixture(db),
      meta = await f.get(),
      table = meta.views.find((v) => v.type === "Table");
    await request(f.path + "/views/" + table.id, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        name: table.name,
        type: table.type,
        version: table.version,
        config: {
          ...table.config,
          sorts: [{ propertyId: f.notes.id, direction: "asc" }],
        },
      },
    });
    const before = await f.stored(),
      beforeMeta = await f.get();
    const projection = (
      await db.query("SELECT property_text FROM page_search WHERE page_id=$1", [
        f.rows[0].pageId,
      ])
    ).rows[0];
    const preview = (await f.preview({ toType: "Number" })).data;
    const expired = {
      previewToken: signConversionToken({
        ...decodeConversionToken(preview.previewToken),
        expires: Date.now() - 1000,
      }),
    };
    assert.equal((await f.apply(expired)).response.status, 409);
    await db.query(
      "CREATE FUNCTION orvyn_conversion_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture conversion rollback'; END $$",
    );
    await db.query(
      `CREATE TRIGGER conversion_test_failure BEFORE UPDATE ON pages FOR EACH ROW WHEN (NEW.id='${f.rows[0].pageId}'::uuid) EXECUTE FUNCTION orvyn_conversion_test_failure()`,
    );
    trigger = true;
    assert.equal((await f.apply(preview)).response.status, 500);
    assert.deepEqual(await f.stored(), before);
    const after = await f.get();
    assert.equal(after.schemaVersion, beforeMeta.schemaVersion);
    assert.deepEqual(after.views, beforeMeta.views);
    assert.equal(
      after.properties.find((p) => p.id === f.notes.id).type,
      "Text",
    );
    assert.deepEqual((await f.history()).data, []);
    assert.deepEqual(
      (
        await db.query(
          "SELECT property_text FROM page_search WHERE page_id=$1",
          [f.rows[0].pageId],
        )
      ).rows[0],
      projection,
    );
  } finally {
    if (trigger) {
      await db.query("DROP TRIGGER conversion_test_failure ON pages");
      await db.query("DROP FUNCTION orvyn_conversion_test_failure()");
    }
    await db.end();
  }
});
