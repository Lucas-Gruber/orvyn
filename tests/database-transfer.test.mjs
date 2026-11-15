import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { databaseAction } from "./ui-helpers.mjs";
test("CSV preview/atomic confirmation and scoped CSV/JSON exports preserve real typed records", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    return {
      ...(await request("auth/me", { cookie: sessionCookie(r.response) })).data,
      cookie: sessionCookie(r.response),
    };
  };
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account();
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Transfer fixture" },
      })
    ).data;
    await pool.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await pool.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const database = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Portable records" },
      })
    ).data;
    const path = "databases/" + database.id;
    const number = (
      await request(path + "/properties", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Estimate", type: "Number" },
      })
    ).data;
    const count = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM database_records WHERE database_id=$1",
            [database.id],
          )
        ).rows[0].count,
      );
    const upload = async (
      action,
      csv,
      settings = {},
      cookie = owner.cookie,
    ) => {
      const body = new FormData();
      body.append("file", new Blob([csv], { type: "text/csv" }), "records.csv");
      body.append("settings", JSON.stringify(settings));
      const response = await fetch(
        base + "/api/v1/" + path + "/import/csv/" + action,
        {
          method: "POST",
          headers: { Origin: process.env.TEST_ORIGIN, Cookie: cookie },
          body,
        },
      );
      return { status: response.status, data: await response.json() };
    };
    const csv =
      'Name,Estimate,Status,Date,Details\r\n"Überblick, first",2.5,Custom,2026-11-20,"Two lines\nwith ""quotes"""\r\n=SUM(A1:A3),-4,Custom,2026-11-21,=1+1\r\n';
    const preview = await upload("preview", csv);
    assert.equal(preview.status, 201, JSON.stringify(preview.data));
    assert.equal(preview.data.canImport, true, JSON.stringify(preview.data));
    assert.equal(preview.data.newProperties.length, 1);
    assert.equal(preview.data.optionAdditions[0].labels[0], "Custom");
    assert.equal(
      await count(),
      0,
      "preview must not create properties or records",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM database_properties WHERE database_id=$1 AND name=$2",
          [database.id, "Details"],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal((await upload("preview", csv, {}, viewer.cookie)).status, 404);
    assert.equal(
      (await upload("preview", csv, {}, outsider.cookie)).status,
      404,
    );
    assert.equal(
      (await upload("confirm", csv + "changed", { token: preview.data.token }))
        .status,
      400,
    );
    assert.equal(await count(), 0);
    const imported = await upload("confirm", csv, {
      token: preview.data.token,
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.data));
    assert.equal(imported.data.createdRecords, 2);
    assert.equal(await count(), 2);
    const replay = await upload("confirm", csv, { token: preview.data.token });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.equal(await count(), 2);
    const records = (
      await request(path + "/query", {
        method: "POST",
        cookie: owner.cookie,
        body: {},
      })
    ).data.records;
    assert.equal(
      records.find((r) => r.title === "Überblick, first").values[number.id],
      2.5,
    );
    const exported = await request(path + "/export.json", {
      cookie: owner.cookie,
    });
    assert.equal(exported.response.status, 200);
    assert.equal(exported.data.records.length, 2);
    assert.equal(
      exported.data.records.find((r) => r.title.startsWith("=")).title,
      "=SUM(A1:A3)",
    );
    assert.equal(exported.data.records[0].document.type, "doc");
    const safe = await request(path + "/export.csv", { cookie: owner.cookie });
    assert.ok(safe.data.includes("'=SUM(A1:A3)"));
    assert.ok(safe.data.includes("'=1+1"));
    assert.ok(safe.data.includes("-4"));
    assert.ok(
      safe.response.headers
        .get("content-disposition")
        .startsWith("attachment;"),
    );
    const raw = await request(path + "/export.csv?spreadsheetSafe=false", {
      cookie: owner.cookie,
    });
    assert.ok(raw.data.includes(",=1+1"));
    assert.ok(!raw.data.includes("'=SUM"));
    const invalid = await upload(
      "preview",
      "Name,Estimate\nValid,3\nInvalid,no-number",
    );
    assert.equal(invalid.status, 201);
    assert.equal(invalid.data.canImport, false);
    assert.equal(invalid.data.token, null);
    assert.equal(invalid.data.errors[0].row, 3);
    assert.equal(await count(), 2);
    const missing = await upload("preview", "Name,Estimate\nMissing,");
    assert.equal(missing.data.canImport, true);
    const stale = await upload("preview", "Name\nStale");
    await request(path + "/properties", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Schema changed", type: "Text" },
    });
    assert.equal(
      (await upload("confirm", "Name\nStale", { token: stale.data.token }))
        .status,
      409,
    );
    assert.equal(await count(), 2);
    const privateRecord = (
      await request(path + "/records", {
        method: "POST",
        cookie: owner.cookie,
        body: {
          title: "PRIVATE EXPORT SECRET",
          visibility: "restricted",
          values: {},
        },
      })
    ).data;
    assert.ok(privateRecord.pageId, JSON.stringify(privateRecord));
    const readable = await request(path + "/export.json", {
      cookie: viewer.cookie,
    });
    assert.equal(readable.response.status, 200);
    assert.equal(readable.data.records.length, 2);
    assert.ok(!JSON.stringify(readable.data).includes("PRIVATE EXPORT SECRET"));
    assert.equal(
      (await request(path + "/export.json", { cookie: outsider.cookie }))
        .response.status,
      404,
    );
    const view = database.views.find((v) => v.type === "Table");
    const titleProp = database.properties.find((p) => p.type === "Title");
    const update = await request(path + "/views/" + view.id, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        version: view.version,
        name: view.name,
        type: view.type,
        config: {
          ...view.config,
          filters: [{ propertyId: number.id, operator: "gt", value: 0 }],
          visibleProperties: [titleProp.id],
        },
      },
    });
    assert.equal(update.response.status, 200, JSON.stringify(update.data));
    const filtered = await request(path + "/export.json?viewId=" + view.id, {
      cookie: viewer.cookie,
    });
    assert.equal(filtered.response.status, 200);
    assert.equal(filtered.data.records.length, 1);
    assert.deepEqual(
      filtered.data.database.properties.map((p) => p.id),
      [titleProp.id],
    );
    assert.equal(Object.keys(filtered.data.records[0].values).length, 1);
  } finally {
    await pool.end();
  }
});

test("Chromium: CSV mapping preview requires review before import and exports the imported records", async () => {
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base);
    await page
      .getByLabel("Email", { exact: true })
      .fill(randomUUID() + "@example.test");
    await page
      .getByLabel("Password · at least 12 characters", { exact: true })
      .fill(randomUUID());
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page
      .getByLabel("New private space", { exact: true })
      .fill("CSV browser");
    await page
      .getByRole("button", { name: "Create space", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New database", exact: true })
      .click();
    await page
      .getByLabel("Database name", { exact: true })
      .fill("CSV workflow");
    await page
      .getByRole("button", { name: "Create database", exact: true })
      .click();
    await databaseAction(page, "Import / export");
    await page.getByLabel("CSV file", { exact: true }).setInputFiles({
      name: "records.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Name,Estimate\nImported through browser,12.5"),
    });
    await page
      .getByRole("button", { name: "Preview CSV", exact: true })
      .click();
    await expect(
      page.getByRole("table", { name: "Column mapping" }),
    ).toBeVisible();
    await page
      .getByLabel("Type for Estimate", { exact: true })
      .selectOption("Number");
    await expect(
      page.getByRole("button", {
        name: "Confirm import of 1 records",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Update preview", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Confirm import of 1 records",
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Confirm import of 1 records", exact: true })
      .click();
    await expect(
      page.getByText("Imported 1 records and 1 properties.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Imported through browser",
        exact: true,
      }),
    ).toBeVisible();
    const downloadWait = page.waitForEvent("download");
    await page
      .getByRole("link", {
        name: "Export all accessible records as JSON",
        exact: true,
      })
      .click();
    const download = await downloadWait;
    const stream = await download.createReadStream();
    let raw = "";
    for await (const chunk of stream) raw += chunk;
    const exported = JSON.parse(raw);
    assert.equal(exported.records[0].title, "Imported through browser");
    const estimate = exported.database.properties.find(
      (p) => p.name === "Estimate",
    );
    assert.equal(exported.records[0].values[estimate.id], 12.5);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
