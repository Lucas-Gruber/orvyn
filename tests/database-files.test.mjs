import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import {
  chooseSpace,
  openPageFromSidebar,
  showAttachments,
} from "./ui-helpers.mjs";
async function account() {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function upload(owner, pageId, name, content) {
  const body = new FormData();
  body.append("file", new Blob([content]), name);
  const response = await fetch(base + "/api/v1/pages/" + pageId + "/files", {
    method: "POST",
    headers: { Cookie: owner.cookie, Origin: process.env.TEST_ORIGIN },
    body,
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return data;
}
test("Files properties restrict references to owned ready attachments and sanitize deleted-file queries and exports", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "File properties" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const database = (
        await request(`spaces/${space.id}/databases`, {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "File records" },
        })
      ).data,
      path = "databases/" + database.id;
    const property = (
      await request(path + "/properties", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Documents", type: "Files" },
      })
    ).data;
    assert.equal(property.type, "Files");
    const add = async (title, visibility = "space", values = {}) =>
      request(path + "/records", {
        method: "POST",
        cookie: owner.cookie,
        body: { title, visibility, values },
      });
    const publicRecord = (await add("Public record")).data,
      privateRecord = (await add("Private record", "restricted")).data;
    const original = await upload(
        owner,
        publicRecord.pageId,
        "readable.txt",
        "Real public attachment",
      ),
      hidden = await upload(
        owner,
        privateRecord.pageId,
        "PRIVATE FILE NAME.txt",
        "Secret bytes",
      );
    const query = async (filters = [], cookie = owner.cookie) =>
      request(path + "/query", { method: "POST", cookie, body: { filters } });
    const publicNow = (await query()).data.records.find(
      (r) => r.pageId === publicRecord.pageId,
    );
    assert.ok(
      publicNow.version > publicRecord.version,
      "completed uploads invalidate old record revisions",
    );
    assert.equal(publicNow.files[0].id, original.id);
    assert.ok(!JSON.stringify(publicNow).includes(hidden.id));
    const patch = (version, ids) =>
      request(path + "/records/" + publicRecord.pageId, {
        method: "PATCH",
        cookie: owner.cookie,
        body: { version, values: { [property.id]: ids } },
      });
    assert.equal(
      (await patch(publicNow.version, [hidden.id])).response.status,
      400,
    );
    assert.equal(
      (await patch(publicNow.version, ["bad-id"])).response.status,
      400,
    );
    assert.equal(
      (await patch(publicNow.version, [original.id, original.id])).response
        .status,
      400,
    );
    assert.equal(
      (await add("Invalid source", "space", { [property.id]: [original.id] }))
        .response.status,
      400,
    );
    const linked = await patch(publicNow.version, [original.id.toUpperCase()]);
    assert.equal(linked.response.status, 200, JSON.stringify(linked.data));
    assert.deepEqual(linked.data.values[property.id], [original.id]);
    const filter = (operator) => [
      { propertyId: property.id, operator, value: original.id },
    ];
    assert.equal((await query(filter("contains"))).data.records.length, 1);
    const visible = await query([], viewer.cookie);
    assert.equal(visible.data.records.length, 1);
    assert.deepEqual(visible.data.records[0].values[property.id], [
      original.id,
    ]);
    assert.ok(!JSON.stringify(visible.data).includes("PRIVATE FILE NAME"));
    assert.equal(
      (
        await request("files/" + original.id + "/download", {
          cookie: viewer.cookie,
        })
      ).data,
      "Real public attachment",
    );
    assert.equal(
      (
        await request("files/" + hidden.id + "/download", {
          cookie: viewer.cookie,
        })
      ).response.status,
      404,
    );
    assert.equal((await query([], outsider.cookie)).response.status, 404);
    const exportBefore = (
      await request(path + "/export.json", { cookie: viewer.cookie })
    ).data;
    assert.deepEqual(exportBefore.records[0].values[property.id], [
      original.id,
    ]);
    assert.ok(!JSON.stringify(exportBefore).includes(hidden.id));
    assert.equal(
      (
        await request("files/" + original.id, {
          method: "DELETE",
          cookie: viewer.cookie,
          body: {},
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request("files/" + original.id, {
          method: "DELETE",
          cookie: owner.cookie,
          body: {},
        })
      ).response.status,
      200,
    );
    const after = (await query([], viewer.cookie)).data.records[0];
    assert.deepEqual(after.values[property.id], []);
    assert.deepEqual(after.files, []);
    assert.equal(
      (await query(filter("contains"), viewer.cookie)).data.records.length,
      0,
    );
    assert.equal(
      (
        await query(
          [{ propertyId: property.id, operator: "empty" }],
          viewer.cookie,
        )
      ).data.records.length,
      1,
    );
    const json = await request(path + "/export.json", {
      cookie: viewer.cookie,
    });
    assert.ok(!JSON.stringify(json.data).includes(original.id));
    const csv = await request(path + "/export.csv", { cookie: viewer.cookie });
    assert.ok(!csv.data.includes(original.id));
    assert.ok(!csv.data.includes(hidden.id));
    assert.equal(
      (await patch(after.version, [original.id])).response.status,
      400,
    );
    assert.equal(
      (
        await request("files/" + original.id + "/download", {
          cookie: viewer.cookie,
        })
      ).response.status,
      404,
    );
    const raw = (
      await db.query("SELECT values FROM database_records WHERE page_id=$1", [
        publicRecord.pageId,
      ])
    ).rows[0].values;
    assert.deepEqual(
      raw[property.id],
      [original.id],
      "read projection hides removed references without rewriting historical stored values",
    );
    const csvInput =
      "Name,Documents\nImported without copied files," + hidden.id;
    const csvPreview = async (settings = {}) => {
      const body = new FormData();
      body.append("file", new Blob([csvInput]), "records.csv");
      body.append("settings", JSON.stringify(settings));
      return (
        await fetch(base + "/api/v1/" + path + "/import/csv/preview", {
          method: "POST",
          headers: { Cookie: owner.cookie, Origin: process.env.TEST_ORIGIN },
          body,
        })
      ).json();
    };
    const preview = await csvPreview();
    assert.equal(preview.canImport, true);
    assert.equal(
      preview.mapping[1].skip,
      true,
      "CSV never copies opaque attachment IDs to new record pages",
    );
    const invalidPreview = await csvPreview({
      mapping: [
        {
          column: 0,
          propertyId: database.properties.find((p) => p.type === "Title").id,
        },
        { column: 1, propertyId: property.id },
      ],
    });
    assert.equal(invalidPreview.canImport, false);
    assert.equal(invalidPreview.token, null);
  } finally {
    await db.end();
  }
});

test("Chromium: upload on a record, select in Files property and download original bytes", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
  try {
    const owner = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "File browser space" },
        })
      ).data,
      database = (
        await request(`spaces/${space.id}/databases`, {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "File browser database" },
        })
      ).data,
      path = "databases/" + database.id;
    await request(path + "/properties", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Documents", type: "Files" },
    });
    const record = (
      await request(path + "/records", {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Files in browser", values: {} },
      })
    ).data;
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "orvyn_session",
        value: owner.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await chooseSpace(page, space.name);
    await openPageFromSidebar(page, database.title);
    await page
      .getByRole("button", { name: "Manage record attachments", exact: true })
      .click();
    await showAttachments(page);
    await page.getByLabel("Choose attachment", { exact: true }).setInputFiles({
      name: "database-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Downloaded through a file property"),
    });
    await page
      .getByRole("button", { name: "Upload attachment", exact: true })
      .click();
    await expect(
      page.getByRole("link", {
        name: "Download database-file.txt",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to database", exact: true })
      .click();
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().endsWith("/records/" + record.pageId),
    );
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Documents options",
      exact: true,
    });
    await picker
      .getByRole("option", { name: "database-file.txt", exact: true })
      .click();
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const link = page.getByRole("link", {
      name: "database-file.txt",
      exact: true,
    });
    await expect(link).toBeVisible();
    const next = page.waitForEvent("download");
    await link.click();
    const download = await next,
      stream = await download.createReadStream();
    let bytes = "";
    for await (const chunk of stream) bytes += chunk;
    assert.equal(bytes, "Downloaded through a file property");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
