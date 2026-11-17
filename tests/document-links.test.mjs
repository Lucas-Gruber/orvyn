import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/index.js";
async function account() {
  const password = randomUUID();
  const result = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password },
    }),
    cookie = sessionCookie(result.response);
  assert.equal(result.response.status, 201);
  return { ...(await request("auth/me", { cookie })).data, cookie, password };
}
async function create(
  owner,
  spaceId,
  title,
  content = [{ type: "paragraph" }],
  parentId = null,
) {
  const page = (
    await request(`spaces/${spaceId}/pages`, {
      cookie: owner.cookie,
      method: "POST",
      body: { title, parentId },
    })
  ).data;
  const saved = await request("pages/" + page.id, {
    cookie: owner.cookie,
    method: "PUT",
    body: { title, version: page.version, document: { type: "doc", content } },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
  return { ...page, ...saved.data };
}
test("heading destinations enforce inherited access, support legacy/duplicate labels and disappear from trash", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account(),
      space = (
        await request("spaces", {
          cookie: owner.cookie,
          method: "POST",
          body: { name: "Link destinations" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const page = await create(owner, space.id, "Visible document", [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Overview" }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Overview" }],
      },
    ]);
    const headings = await request(`pages/${page.id}/headings`, {
      cookie: viewer.cookie,
    });
    assert.equal(headings.response.status, 200);
    assert.equal(headings.data.length, 2);
    assert.notEqual(headings.data[0].id, headings.data[1].id);
    assert.deepEqual(
      (await request(`pages/${page.id}/headings`, { cookie: viewer.cookie }))
        .data,
      headings.data,
    );
    assert.equal(
      (await request(`pages/${page.id}/headings`, { cookie: outsider.cookie }))
        .response.status,
      404,
    );
    assert.equal(
      (await request(`pages/${page.id}/headings`)).response.status,
      401,
    );
    const parent = await create(owner, space.id, "Restricted parent"),
      child = await create(
        owner,
        space.id,
        "Restricted target",
        [
          {
            type: "heading",
            attrs: { level: 2, id: randomUUID() },
            content: [{ type: "text", text: "Confidential section" }],
          },
        ],
        parent.id,
      );
    await request(`pages/${parent.id}/permissions`, {
      cookie: owner.cookie,
      method: "PUT",
      body: {
        version: parent.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    const denied = await request(`pages/${child.id}/headings`, {
      cookie: viewer.cookie,
    });
    assert.equal(denied.response.status, 404);
    assert.ok(!JSON.stringify(denied.data).includes("Confidential section"));
    await request(`pages/${page.id}`, {
      cookie: owner.cookie,
      method: "DELETE",
      body: { confirm: true },
    });
    assert.equal(
      (await request(`pages/${page.id}/headings`, { cookie: viewer.cookie }))
        .response.status,
      404,
    );
  } finally {
    await db.end();
  }
});

test("Chromium: read-only legacy heading links, sign-in continuation and denied destinations do not grant access", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    readerContext = await browser.newContext({
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    }),
    writerContext = await browser.newContext({ reducedMotion: "reduce" }),
    reader = await readerContext.newPage(),
    writer = await writerContext.newPage(),
    errors = [];
  reader.on("pageerror", (e) => errors.push(e.message));
  writer.on("pageerror", (e) => errors.push(e.message));
  try {
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          cookie: owner.cookie,
          method: "POST",
          body: { name: "Team references" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const target = await create(owner, space.id, "Shared reference", [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Legacy section" }],
        },
      ]),
      legacy = (
        await request(`pages/${target.id}/headings`, { cookie: viewer.cookie })
      ).data[0],
      source = await create(owner, space.id, "Reference index", [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Open the reference",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: pageLink(target.id, legacy.id),
                    target: "_self",
                  },
                },
              ],
            },
          ],
        },
      ]);
    await readerContext.addCookies([
      {
        name: "orvyn_session",
        value: viewer.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await reader.goto(base + pageLink(target.id, legacy.id));
    const heading = reader.locator('[id="h-' + legacy.id + '"]');
    await expect(heading).toHaveAttribute("data-link-target", "true");
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveAttribute("contenteditable", "false");
    await expect(
      reader.getByRole("button", { name: "Text formatting", exact: true }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("toolbar", { name: "Text formatting", exact: true }),
    ).not.toBeVisible();
    await expect(
      reader.locator('.editor-toolbar button[aria-label="Link to document"]'),
    ).toBeDisabled();
    assert.equal(
      (await request("pages/" + target.id, { cookie: owner.cookie })).data
        .version,
      target.version,
      "read-only rendering must not mutate a legacy document",
    );
    await heading
      .getByRole("button", {
        name: "Copy link to heading Legacy section",
        exact: true,
      })
      .click();
    await expect(
      reader.getByText("Heading link copied.", { exact: true }),
    ).toBeVisible();
    const copied = await reader.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, base + pageLink(target.id, legacy.id));
    await writer.goto(copied);
    await writer.getByLabel("Email", { exact: true }).fill(owner.email);
    await writer
      .getByLabel("Password · at least 12 characters", { exact: true })
      .fill(owner.password);
    await writer.getByRole("button", { name: "Sign in", exact: true }).click();
    const writerHeading = writer.locator('[id="h-' + legacy.id + '"]');
    await expect(writerHeading).toHaveAttribute("data-link-target", "true");
    await expect(
      writer.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeEditable();
    await writerHeading.click();
    await writer.keyboard.press("Home");
    await writer.keyboard.press("Shift+End");
    await writer.keyboard.type("Renamed reference");
    await expect(
      writer.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await expect(heading).toContainText("Renamed reference");
    assert.equal(
      (await request(`pages/${target.id}/headings`, { cookie: owner.cookie }))
        .data[0].id,
      legacy.id,
    );
    const current = (
      await request("pages/" + target.id, { cookie: owner.cookie })
    ).data;
    const revoke = await request(`pages/${target.id}/permissions`, {
      cookie: owner.cookie,
      method: "PUT",
      body: {
        version: current.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    assert.equal(revoke.response.status, 200);
    await reader.goto(base + pageLink(source.id));
    await expect(
      reader.getByRole("link", { name: "Open the reference", exact: true }),
    ).toBeVisible();
    await reader
      .getByRole("link", { name: "Open the reference", exact: true })
      .click();
    await expect(reader.locator(".toast[role=alert]")).toBeVisible();
    await expect(reader.getByLabel("Page title", { exact: true })).toHaveValue(
      "Reference index",
    );
    await expect(
      reader.getByRole("heading", { name: "Renamed reference", exact: true }),
    ).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await readerContext.close();
    await writerContext.close();
    await browser.close();
    await db.end();
  }
});
test("Chromium: slash commands, document links, permanent heading links, renames, clipboard, reload and missing anchors", async () => {
  const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account(),
      firstSpace = (
        await request("spaces", {
          cookie: owner.cookie,
          method: "POST",
          body: { name: "Writing" },
        })
      ).data,
      targetSpace = (
        await request("spaces", {
          cookie: owner.cookie,
          method: "POST",
          body: { name: "Knowledge" },
        })
      ).data,
      headingId = randomUUID(),
      target = await create(owner, targetSpace.id, "Architecture", [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Overview" }],
        },
        ...Array.from({ length: 35 }, (_, i) => ({
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `Background ${i + 1}. Decisions and context for the system.`,
            },
          ],
        })),
        {
          type: "heading",
          attrs: { level: 4, id: headingId },
          content: [{ type: "text", text: "Deployment" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "The section linked from the project notes.",
            },
          ],
        },
      ]),
      source = await create(owner, firstSpace.id, "Project notes");
    await context.addCookies([
      {
        name: "orvyn_session",
        value: owner.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.goto(base + pageLink(source.id));
    const document = page.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(document).toBeEditable();
    await document.pressSequentially("/heading 2");
    await expect(
      page.getByRole("listbox", { name: "Insert block", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Project links");
    await expect(document.locator("h2")).toContainText("Project links");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/link");
    await page
      .getByRole("option", { name: "Link to document", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Link to document",
      exact: true,
    });
    await picker
      .getByLabel("Find a document", { exact: true })
      .fill("Architecture");
    await picker
      .getByRole("button", { name: /Architecture Knowledge/ })
      .click();
    await picker
      .getByRole("button", { name: "Link to heading Deployment", exact: true })
      .click();
    const anchor = document.getByRole("link", {
      name: "Architecture › Deployment",
      exact: true,
    });
    await expect(anchor).toHaveAttribute(
      "href",
      pageLink(target.id, headingId),
    );
    await expect(document).not.toContainText("/link");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await anchor.click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Architecture",
    );
    const heading = page.locator('[id="h-' + headingId + '"]');
    await expect(heading).toHaveAttribute("data-link-target", "true");
    await expect(heading).toBeInViewport();
    await expect(heading).toBeFocused();
    await expect(page).toHaveURL(new RegExp("#h-" + headingId + "$"));
    await page.locator("summary").filter({ hasText: "Backlinks" }).click();
    await page
      .locator(".page-backlinks")
      .getByRole("button", { name: /Project notes Writing/ })
      .click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Project notes",
    );
    await anchor.click();
    await expect(heading).toHaveAttribute("data-link-target", "true");
    await expect(document).toBeEditable();
    // Editing the heading text must keep its identity and incoming links.
    await heading.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.type("Release process");
    await expect(heading).toContainText("Release process");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await heading
      .getByRole("button", {
        name: "Copy link to heading Release process",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Heading link copied.", { exact: true }),
    ).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, base + pageLink(target.id, headingId));
    await page.reload();
    await expect(heading).toContainText("Release process");
    await expect(heading).toHaveAttribute("data-link-target", "true");
    await expect(heading).toBeInViewport();
    await page.screenshot({
      path: ".local/ui-review/document-heading-link.png",
    });
    // A direct URL without a space parameter also works in a fresh tab.
    const fresh = await context.newPage();
    await fresh.goto(copied);
    await expect(fresh.locator('[id="h-' + headingId + '"]')).toBeInViewport();
    await fresh.close();
    await page.goto(base + pageLink(target.id, randomUUID()));
    await expect(
      page.getByText(
        "This heading is no longer in this document. You can still read the document.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Architecture",
    );
    // Toolbar/shortcut links support custom selected text and whole documents.
    await page.goto(base + pageLink(source.id));
    await expect(document).toBeEditable();
    await document.press("Control+End");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+b");
    await page.keyboard.type("Read the architecture");
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.press("Control+k");
    await expect(picker).toBeVisible();
    await picker
      .getByLabel("Find a document", { exact: true })
      .fill("Architecture");
    await picker
      .getByRole("button", { name: /Architecture Knowledge/ })
      .click();
    await expect(
      picker.getByLabel("Link text (optional)", { exact: true }),
    ).toHaveValue("Read the architecture");
    await picker
      .getByRole("button", { name: "Link entire document", exact: true })
      .click();
    await expect(
      document.getByRole("link", {
        name: "Read the architecture",
        exact: true,
      }),
    ).toHaveAttribute("href", pageLink(target.id));
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const savedSource = (
      await request("pages/" + source.id, { cookie: owner.cookie })
    ).data;
    const textNodes = [];
    function collect(node) {
      if (node.type === "text") textNodes.push(node);
      for (const child of node.content || []) collect(child);
    }
    collect(savedSource.document);
    const linkedText = textNodes.find(
      (node) => node.text === "Read the architecture",
    );
    assert.ok(
      linkedText.marks.some((mark) => mark.type === "bold"),
      "linking selected text retains its formatting",
    );
    assert.ok(linkedText.marks.some((mark) => mark.type === "link"));
    await document.press("Control+End");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.keyboard.press("Enter");
    await document.evaluate((element, id) => {
      const data = new DataTransfer();
      data.setData("text/html", '<h2 id="h-' + id + '">Pasted heading</h2>');
      data.setData("text/plain", "Pasted heading");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    }, headingId);
    const pasted = document.getByRole("heading", {
      name: "Pasted heading",
      exact: true,
    });
    await expect(pasted).toBeVisible();
    await expect(pasted).not.toHaveAttribute("id", "h-" + headingId);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const pastedHeadings = (
      await request(`pages/${source.id}/headings`, { cookie: owner.cookie })
    ).data;
    assert.equal(
      new Set(pastedHeadings.map((h) => h.id)).size,
      pastedHeadings.length,
    );
    await document.press("Control+End");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.keyboard.press("Enter");
    await page.keyboard.type("/page");
    await page.keyboard.press("Enter");
    await picker
      .getByLabel("Find a document", { exact: true })
      .fill("Project notes");
    await picker.getByRole("button", { name: /Project notes Writing/ }).click();
    await picker
      .getByRole("button", {
        name: "Link to heading Project links",
        exact: true,
      })
      .click();
    const selfLink = document.getByRole("link", {
        name: "Project notes › Project links",
        exact: true,
      }),
      ownHeading = document.getByRole("heading", {
        name: "Project links",
        exact: true,
      });
    await selfLink.click();
    await expect(ownHeading).toHaveAttribute("data-link-target", "true");
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .focus();
    await selfLink.click();
    await expect(ownHeading).toBeFocused();
    await page.reload();
    await expect(
      document.getByRole("link", {
        name: "Architecture › Deployment",
        exact: true,
      }),
    ).toHaveAttribute("href", pageLink(target.id, headingId));
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Document-link browser errors", errors);
    await page.screenshot({
      path: ".local/ui-review/document-link-failure.png",
      fullPage: true,
    });
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
});
