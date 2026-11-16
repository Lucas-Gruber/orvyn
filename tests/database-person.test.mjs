import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chooseSpace, openPageFromSidebar } from "./ui-helpers.mjs";
test("Person fields validate membership, retain historical IDs and filter/export without granting access", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    const cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  };
  try {
    const owner = await account(),
      member = await account(),
      outsider = await account();
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Assigned people" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      member.id,
    ]);
    const database = (
        await request(`spaces/${space.id}/databases`, {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "People data" },
        })
      ).data,
      path = "databases/" + database.id;
    const property = (
      await request(path + "/properties", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Assignees", type: "Person" },
      })
    ).data;
    assert.equal(property.type, "Person");
    const create = (values) =>
      request(path + "/records", {
        method: "POST",
        cookie: owner.cookie,
        body: {
          title: "Assigned record",
          values: { [property.id]: values },
          visibility: "restricted",
        },
      });
    for (const value of [
      [outsider.id],
      [member.id, member.id],
      member.id,
      ["not-a-user"],
    ])
      assert.equal((await create(value)).response.status, 400);
    const record = (await create([member.id, owner.id])).data;
    assert.ok(record.pageId);
    assert.deepEqual(record.values[property.id], [member.id, owner.id].sort());
    assert.equal(
      (await request("pages/" + record.pageId, { cookie: member.cookie }))
        .response.status,
      404,
      "assignment never grants page access",
    );
    const query = (filter) =>
      request(path + "/query", {
        method: "POST",
        cookie: owner.cookie,
        body: { filters: [{ propertyId: property.id, ...filter }] },
      });
    assert.equal(
      (await query({ operator: "contains", value: member.id })).data.records
        .length,
      1,
    );
    assert.equal(
      (await query({ operator: "eq", value: [member.id, owner.id] })).data
        .records.length,
      1,
    );
    assert.equal((await query({ operator: "empty" })).data.records.length, 0);
    assert.equal(
      (await query({ operator: "contains", value: outsider.id })).data.records
        .length,
      0,
    );
    assert.equal(
      (await query({ operator: "gt", value: [] })).response.status,
      400,
    );
    assert.equal(
      (
        await request(path + "/query", {
          method: "POST",
          cookie: owner.cookie,
          body: { sorts: [{ propertyId: property.id, direction: "asc" }] },
        })
      ).response.status,
      400,
    );
    const upload = async (action, csv, settings = {}) => {
      const body = new FormData();
      body.append("file", new Blob([csv]), "people.csv");
      body.append("settings", JSON.stringify(settings));
      const r = await fetch(
        base + "/api/v1/" + path + "/import/csv/" + action,
        {
          method: "POST",
          headers: { Origin: process.env.TEST_ORIGIN, Cookie: owner.cookie },
          body,
        },
      );
      return { status: r.status, data: await r.json() };
    };
    const csv = "Name,Assignees\nImported person," + member.email;
    const preview = await upload("preview", csv);
    assert.equal(preview.data.canImport, true, JSON.stringify(preview.data));
    const invalid = await upload(
      "preview",
      "Name,Assignees\nHidden," + outsider.email,
    );
    assert.equal(invalid.data.canImport, false);
    assert.equal(invalid.data.errors[0].column, "Assignees");
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [space.id, member.id],
    );
    assert.equal(
      (await upload("confirm", csv, { token: preview.data.token })).status,
      400,
      "confirm rechecks changed membership",
    );
    assert.equal(
      (await create([member.id])).response.status,
      400,
      "former members cannot be assigned anew",
    );
    const kept = await request(path + "/records/" + record.pageId, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        version: record.version,
        values: { [property.id]: [member.id, owner.id] },
      },
    });
    assert.equal(kept.response.status, 200, JSON.stringify(kept.data));
    const reduced = await request(path + "/records/" + record.pageId, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        version: kept.data.version,
        values: { [property.id]: [member.id] },
      },
    });
    assert.equal(reduced.response.status, 200);
    const exported = (
      await request(path + "/export.json", { cookie: owner.cookie })
    ).data;
    assert.deepEqual(exported.records[0].values[property.id], [member.id]);
    assert.ok(
      !JSON.stringify(exported).includes(member.email),
      "historical references do not expose former member email",
    );
    const rawCsv = await request(path + "/export.csv", {
      cookie: owner.cookie,
    });
    assert.ok(rawCsv.data.includes(member.id));
    const cleared = await request(path + "/records/" + record.pageId, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { version: reduced.data.version, values: { [property.id]: [] } },
    });
    assert.equal(cleared.response.status, 200);
    assert.equal((await query({ operator: "empty" })).data.records.length, 1);
    const reassign = await request(path + "/records/" + record.pageId, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        version: cleared.data.version,
        values: { [property.id]: [member.id] },
      },
    });
    assert.equal(reassign.response.status, 400);
  } finally {
    await db.end();
  }
});

test("Chromium: people property creation, multi-assignment, membership filtering and former-member display", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs");
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    const cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  };
  try {
    const owner = await account(),
      member = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Person browser space" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      member.id,
    ]);
    const database = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Person browser database" },
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
    await page.getByText("Add a property", { exact: true }).click();
    await page.getByLabel("Property name", { exact: true }).fill("Assignees");
    await page
      .getByLabel("Property type", { exact: true })
      .selectOption("Person");
    await page
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    await page.getByRole("button", { name: "New record", exact: true }).click();
    await page
      .getByLabel("Record name", { exact: true })
      .fill("Assigned in browser");
    await page.getByRole("button", { name: "Assignees", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Assignees options",
      exact: true,
    });
    await picker
      .getByLabel("Search Assignees", { exact: true })
      .fill(owner.email);
    await picker
      .getByLabel("Search Assignees", { exact: true })
      .press("ArrowDown");
    await expect(
      picker.getByRole("option", { name: owner.email, exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Space");
    await picker.getByLabel("Search Assignees", { exact: true }).fill("");
    await picker
      .getByRole("option", { name: member.email, exact: true })
      .click();
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Create record", exact: true })
      .click();
    const row = page.getByRole("row").filter({
      has: page.getByRole("button", {
        name: "Assigned in browser",
        exact: true,
      }),
    });
    const assigned = row.getByRole("button", {
      name: "Assignees",
      exact: true,
    });
    await expect(assigned).toContainText(owner.email);
    await expect(assigned).toContainText(member.email);
    await page
      .getByRole("button", { name: "View settings", exact: true })
      .click();
    const form = page.getByRole("dialog", {
      name: "View settings",
      exact: true,
    });
    await form.getByRole("button", { name: "Add filter", exact: true }).click();
    await form
      .getByLabel("Filter property", { exact: true })
      .selectOption({ label: "Assignees" });
    await form
      .getByLabel("Filter comparison", { exact: true })
      .selectOption("contains");
    await form
      .getByRole("combobox", { name: "Assignees", exact: true })
      .selectOption(member.id);
    await form.getByRole("button", { name: "Save view", exact: true }).click();
    await expect(row).toBeVisible();
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [space.id, member.id],
    );
    await page
      .getByRole("button", { name: "Refresh records", exact: true })
      .click();
    await expect(assigned).toContainText("Former member");
    await assigned.click();
    const former = picker.getByRole("option", {
      name: "Former member",
      exact: true,
    });
    await expect(former).toHaveAttribute("aria-selected", "true");
    await expect(
      picker.getByRole("option", { name: member.email, exact: true }),
    ).toHaveCount(0);
    await former.click();
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await expect(row).toHaveCount(0); // The saved membership filter no longer matches.
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});
