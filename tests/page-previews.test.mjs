import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
async function account() {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function create(owner, space, title, content = [{ type: "paragraph" }]) {
  const p = (
    await request(`spaces/${space}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title },
    })
  ).data;
  const saved = await request("pages/" + p.id, {
    method: "PUT",
    cookie: owner.cookie,
    body: { version: p.version, title, document: { type: "doc", content } },
  });
  assert.equal(saved.response.status, 200);
  return saved.data;
}
test("document previews require current access, bound text and handle missing headings and cyclic references", async () => {
  const owner = await account(),
    outsider = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Preview rights" },
      })
    ).data,
    headingId = randomUUID(),
    target = await create(owner, space.id, "Target", [
      {
        type: "heading",
        attrs: { level: 2, id: headingId },
        content: [{ type: "text", text: "A section" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "<script>not executed</script> " + "Long text ".repeat(100),
          },
        ],
      },
    ]);
  const get = (cookie, heading = "") =>
    request(`pages/${target.id}/preview?heading=` + heading, { cookie });
  const allowed = await get(owner.cookie, headingId);
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.data.heading.text, "A section");
  assert.ok(allowed.data.excerpt.length <= 280);
  assert.ok(!JSON.stringify(allowed.data).includes('"document":'));
  assert.equal(
    allowed.response.headers.get("Cache-Control"),
    "private, no-store",
  );
  assert.equal((await get(outsider.cookie)).response.status, 404);
  assert.equal((await get()).response.status, 401);
  assert.equal((await get(owner.cookie, "invalid")).response.status, 400);
  assert.equal(
    (await get(owner.cookie, randomUUID())).data.missingHeading,
    true,
  );
  const source = await create(owner, space.id, "Source", [
    { type: "orvynPagePreview", attrs: { pageId: target.id, headingId } },
  ]);
  const updated = await request("pages/" + target.id, { cookie: owner.cookie });
  await request("pages/" + target.id, {
    method: "PUT",
    cookie: owner.cookie,
    body: {
      title: target.title,
      version: updated.data.version,
      document: {
        type: "doc",
        content: [{ type: "orvynPagePreview", attrs: { pageId: source.id } }],
      },
    },
  });
  assert.equal((await get(owner.cookie)).data.excerpt, "");
  assert.deepEqual(
    (
      await request(`pages/${target.id}/backlinks`, { cookie: owner.cookie })
    ).data.map((p) => p.id),
    [source.id],
  );
  await request("pages/" + target.id, {
    method: "DELETE",
    cookie: owner.cookie,
    body: { confirm: true },
  });
  assert.equal((await get(owner.cookie)).response.status, 404);
});
test("Chromium: insert live page/heading preview, refresh renamed destination, navigate, hide revoked content and update backlinks", async () => {
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
    const c = await browser.newContext({
      viewport: { width: 1440, height: 980 },
      reducedMotion: "reduce",
    });
    contexts.push(c);
    await c.addCookies([
      {
        name: "orvyn_session",
        value: user.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const p = await c.newPage();
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
          body: { name: "Team knowledge" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const headingId = randomUUID(),
      target = await create(owner, space.id, "Architecture notes", [
        {
          type: "heading",
          attrs: { level: 2, id: headingId },
          content: [{ type: "text", text: "Deployment" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Build decisions start here. Deployments are reviewed before publication.",
            },
          ],
        },
      ]),
      source = await create(owner, space.id, "Project workspace");
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await doc.click();
    await page.keyboard.type("/preview");
    await page
      .getByRole("option", { name: "Page preview", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Insert page preview",
      exact: true,
    });
    await picker
      .getByLabel("Find a document", { exact: true })
      .fill("Architecture notes");
    await picker
      .getByRole("button", { name: /Architecture notes Team knowledge/ })
      .click();
    await expect(
      picker.getByLabel("Link text (optional)", { exact: true }),
    ).toHaveCount(0);
    await picker
      .getByRole("button", { name: "Preview heading Deployment", exact: true })
      .click();
    const card = doc.locator(".page-preview-card");
    await expect(card).toContainText("Architecture notes");
    await expect(card).toContainText("Build decisions start here.");
    await expect(card).toHaveAttribute("href", pageLink(target.id, headingId));
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/ui-review/page-preview.png",
      fullPage: true,
    });
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    const readerCard = reader.locator(".page-preview-card");
    await expect(readerCard).toContainText("Architecture notes");
    await expect(
      reader.getByRole("button", { name: "Remove page preview", exact: true }),
    ).toHaveCount(0);
    const current = (
      await request("pages/" + target.id, { cookie: owner.cookie })
    ).data;
    await request(`pages/${target.id}/title`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        title: "Architecture decisions",
        titleVersion: current.title_version,
      },
    });
    await page
      .getByRole("button", { name: "Refresh document preview", exact: true })
      .click();
    await expect(card).toContainText("Architecture decisions");
    await card.click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Architecture decisions",
    );
    await expect(page.locator('[id="h-' + headingId + '"]')).toHaveAttribute(
      "data-link-target",
      "true",
    );
    await page.goBack();
    await expect(card).toContainText("Architecture decisions");
    const latest = (
      await request("pages/" + target.id, { cookie: owner.cookie })
    ).data;
    await request(`pages/${target.id}/permissions`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: latest.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    await reader
      .getByRole("button", { name: "Refresh document preview", exact: true })
      .click();
    await expect(
      reader.getByText(
        "This document is unavailable or you do not have access.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(readerCard).toHaveCount(0);
    assert.ok(
      !(await reader.locator("body").innerText()).includes(
        "Build decisions start here.",
      ),
    );
    await page
      .getByRole("button", { name: "Remove page preview", exact: true })
      .click();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    assert.deepEqual(
      (await request(`pages/${target.id}/backlinks`, { cookie: owner.cookie }))
        .data,
      [],
    );
    assert.deepEqual(errors, []);
  } catch (e) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/page-preview-failure.png",
        fullPage: true,
      });
    console.error("Preview browser errors", errors);
    throw e;
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await db.end();
  }
});
