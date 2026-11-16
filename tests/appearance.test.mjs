import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import {
  appearanceInput,
  validEmoji,
  coverBackground,
} from "../packages/shared/dist/index.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=",
  "base64",
);
const account = async () => {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
};
const create = async (owner, space, title) =>
  (
    await request(`spaces/${space}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title },
    })
  ).data;
async function upload(owner, pageId, bytes = png, filename = "cover.png") {
  const body = new FormData();
  body.append("file", new Blob([bytes]), filename);
  const r = await fetch(`${base}/api/v1/pages/${pageId}/files`, {
    method: "POST",
    headers: { Origin: process.env.TEST_ORIGIN, Cookie: owner.cookie },
    body,
  });
  assert.equal(r.status, 201);
  return r.json();
}
const input = (version = 1) => ({
  appearanceVersion: version,
  icon: "🚀",
  coverPreset: "aurora",
  coverFileId: null,
});
test("appearance validates a single emoji and fixed cover styles without accepting URLs or CSS", () => {
  for (const value of [null, "🚀", "🗂️", "👨‍👩‍👧‍👦", "🇩🇪", "1️⃣"])
    assert.ok(validEmoji(value));
  for (const value of ["", "hello", "🚀🚀", "<img src=x>", "🚀\n", "🚀\u202e"])
    assert.equal(validEmoji(value), false);
  assert.ok(appearanceInput.safeParse(input()).success);
  assert.ok(
    !appearanceInput.safeParse({ ...input(), coverFileId: randomUUID() })
      .success,
  );
  assert.ok(
    !appearanceInput.safeParse({
      ...input(),
      coverPreset: "url(https://tracking.test/)",
    }).success,
  );
  assert.equal(coverBackground("__proto__"), "");
  assert.equal(coverBackground("https://tracking.test/"), "");
});
test("page/space appearance enforces roles, independent versions, current-page image ownership and attachment cleanup", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account(),
      editor = await account(),
      viewer = await account(),
      outsider = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Appearance rights" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query(
      "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer')",
      [space.id, editor.id, viewer.id],
    );
    const source = await create(owner, space.id, "Decorated page"),
      other = await create(owner, space.id, "Other attachments"),
      image = await upload(owner, source.id),
      foreign = await upload(owner, other.id),
      unsafe = await upload(
        owner,
        source.id,
        "<svg onload=alert(1)>",
        "unsafe.svg",
      ),
      change = (body, cookie = owner.cookie, resource = `pages/${source.id}`) =>
        request(resource + "/appearance", { method: "PATCH", cookie, body });
    for (const cookie of [viewer.cookie, outsider.cookie])
      assert.equal((await change(input(), cookie)).response.status, 404);
    assert.equal(
      (await change(input(), undefined, `spaces/${space.id}`)).response.status,
      200,
    );
    assert.equal(
      (await change(input(2), editor.cookie, `spaces/${space.id}`)).response
        .status,
      404,
    );
    assert.equal(
      (
        await request(`spaces/${space.id}/appearance`, {
          cookie: outsider.cookie,
        })
      ).response.status,
      404,
    );
    const results = await Promise.all([
      change(input(), editor.cookie),
      change({ ...input(), icon: "📚" }, editor.cookie),
    ]);
    assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
    let p = (await request(`pages/${source.id}`, { cookie: owner.cookie }))
      .data;
    assert.equal(p.appearance_version, 2);
    assert.equal(p.title_version, source.title_version);
    assert.deepEqual(p.document, source.document);
    assert.equal(
      (
        await request(`pages/${source.id}/title`, {
          method: "PATCH",
          cookie: owner.cookie,
          body: {
            title: "Renamed separately",
            titleVersion: source.title_version,
          },
        })
      ).response.status,
      200,
    );
    const cover = (id) => ({
      ...input(p.appearance_version),
      coverPreset: null,
      coverFileId: id,
    });
    for (const id of [foreign.id, unsafe.id, randomUUID()])
      assert.equal((await change(cover(id))).response.status, 400);
    await db.query("UPDATE files SET state='pending' WHERE id=$1", [image.id]);
    assert.equal((await change(cover(image.id))).response.status, 400);
    await db.query("UPDATE files SET state='ready' WHERE id=$1", [image.id]);
    assert.equal((await change(cover(image.id))).response.status, 200);
    assert.equal(
      (
        await change(
          { ...cover(image.id), appearanceVersion: 2 },
          owner.cookie,
          `spaces/${space.id}`,
        )
      ).response.status,
      400,
    );
    await request(`files/${image.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    p = (await request(`pages/${source.id}`, { cookie: owner.cookie })).data;
    assert.equal(
      (
        await change({
          ...cover(image.id),
          appearanceVersion: p.appearance_version,
          icon: "✅",
        })
      ).response.status,
      200,
    );
    await db.query("DELETE FROM files WHERE id=$1", [image.id]);
    assert.equal(
      (await request(`pages/${source.id}`, { cookie: owner.cookie })).data
        .cover_file_id,
      null,
    );
    assert.equal(
      (await request(`files/${image.id}/preview`, { cookie: outsider.cookie }))
        .response.status,
      404,
    );
    assert.equal(
      (
        await request(`pages/${source.id}/appearance`, {
          method: "PATCH",
          body: input(),
        })
      ).response.status,
      401,
    );
    const database = (
        await request(`spaces/${space.id}/databases`, {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Decorated records", includeDefaults: false },
        })
      ).data,
      record = (
        await request(`databases/${database.id}/records`, {
          method: "POST",
          cookie: owner.cookie,
          body: { title: "A record" },
        })
      ).data,
      recordImage = await upload(owner, record.pageId),
      query = async () =>
        (
          await request(`databases/${database.id}/query`, {
            method: "POST",
            cookie: owner.cookie,
            body: {},
          })
        ).data.records[0];
    assert.equal((await query()).coverFileId, recordImage.id);
    assert.equal(
      (
        await change(
          { ...input(), coverPreset: "meadow", icon: "🌿" },
          owner.cookie,
          `pages/${record.pageId}`,
        )
      ).response.status,
      200,
    );
    assert.equal((await query()).coverPreset, "meadow");
    assert.equal((await query()).icon, "🌿");
    assert.equal(
      (
        await change(
          { ...input(2), coverPreset: null },
          owner.cookie,
          `pages/${record.pageId}`,
        )
      ).response.status,
      200,
    );
    assert.equal(
      (await query()).coverFileId,
      null,
      "Explicitly removing a cover must not select another attachment",
    );
  } finally {
    await db.end();
  }
});
test("Chromium: page/space icons, covers, private image selection, stale appearance recovery, read-only and mobile", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  let page;
  async function session(user) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    contexts.push(context);
    await context.addCookies([
      {
        name: "orvyn_session",
        value: user.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    return p;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Studio" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const source = await create(owner, space.id, "Product handbook"),
      image = await upload(owner, source.id);
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true }),
      dialog = page.getByRole("dialog", {
        name: "Page appearance",
        exact: true,
      });
    await expect(doc).toBeEditable();
    await doc.fill(
      "A shared place for the team's decisions, principles and next steps.",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    await page
      .getByRole("button", { name: "Change page icon and cover", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Books icon", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Aurora", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Save appearance", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".page-symbol .page-emoji")).toHaveText("📚");
    await expect(
      page
        .getByRole("navigation", { name: "Pages", exact: true })
        .locator(".page-emoji"),
    ).toHaveText("📚");
    assert.ok(
      (
        await page
          .getByRole("navigation", { name: "Pages", exact: true })
          .locator(".page-emoji")
          .boundingBox()
      ).width < 20,
    );
    await expect(page.locator("article > .cover-banner")).toHaveCSS(
      "background-image",
      /linear-gradient/,
    );
    await page.screenshot({
      path: ".local/ui-review/page-cover.png",
      fullPage: true,
    });
    await page.reload();
    await expect(doc).toHaveText(
      "A shared place for the team's decisions, principles and next steps.",
    );
    await page
      .getByRole("button", { name: "Change page icon and cover", exact: true })
      .click();
    const current = (
      await request(`pages/${source.id}`, { cookie: owner.cookie })
    ).data;
    await request(`pages/${source.id}/appearance`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        ...input(current.appearance_version),
        icon: "🎯",
        coverPreset: "dusk",
      },
    });
    await dialog
      .getByRole("button", { name: "Save appearance", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("Appearance changed");
    await dialog
      .getByRole("button", { name: "Reload saved appearance", exact: true })
      .click();
    await expect(dialog.getByLabel("Icon", { exact: true })).toHaveValue("🎯");
    await dialog
      .getByRole("button", { name: "Choose image", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Insert image",
      exact: true,
    });
    await picker.getByRole("button", { name: /cover.png/ }).click();
    await dialog
      .getByRole("button", { name: "Save appearance", exact: true })
      .click();
    await expect(page.locator("article > .cover-banner img")).toHaveAttribute(
      "src",
      `/api/v1/files/${image.id}/preview`,
    );
    await expect
      .poll(() =>
        page
          .locator("article > .cover-banner img")
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveAttribute("contenteditable", "false", { timeout: 12000 });
    await expect(
      reader.getByRole("button", {
        name: "Change page icon and cover",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(reader.locator("article > .cover-banner img")).toHaveAttribute(
      "src",
      `/api/v1/files/${image.id}/preview`,
    );
    await request(`files/${image.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    await reader.reload();
    await expect(
      reader.getByText("Cover unavailable", { exact: true }),
    ).toBeVisible();
    await reader.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page
      .getByRole("button", { name: "Space settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Space icon and cover", exact: true })
      .click();
    const spaceDialog = page.getByRole("dialog", {
      name: "Space appearance",
      exact: true,
    });
    await spaceDialog
      .getByRole("button", { name: "Plant icon", exact: true })
      .click();
    await spaceDialog
      .getByRole("button", { name: "Meadow", exact: true })
      .click();
    await spaceDialog
      .getByRole("button", { name: "Save appearance", exact: true })
      .click();
    await expect(spaceDialog).not.toBeVisible();
    await expect(
      page
        .getByRole("button", { name: "Switch space", exact: true })
        .locator(".page-emoji"),
    ).toHaveText("🌿");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".space-home > .cover-banner")).toHaveCSS(
      "background-image",
      /linear-gradient/,
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/appearance-failure.png",
        fullPage: true,
      });
    console.error("Appearance browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});
