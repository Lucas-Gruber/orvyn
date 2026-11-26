import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

test("Chromium: Markdown clipboard formatting, fresh heading links, undo, collaboration, plain paste, code and rich HTML", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const errors = [];
  async function account(displayName) {
    const registered = await request("auth/register", {
      method: "POST",
      body: {
        email: randomUUID() + "@example.test",
        password: randomUUID(),
        displayName,
      },
    });
    const cookie = sessionCookie(registered.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  async function session(account) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addCookies([
      {
        name: "orvyn_session",
        value: account.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  try {
    const owner = await account("Mara Keller");
    const viewer = await account("Jonas Weber");
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Product studio" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const page = await session(owner);
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    async function openBlank(title) {
      const source = (
        await request(`spaces/${space.id}/pages`, {
          method: "POST",
          cookie: owner.cookie,
          body: { title },
        })
      ).data;
      await page.goto(base + "/?page=" + source.id);
      await expect(doc).toBeEditable();
      await doc.click();
      return source;
    }
    async function paste(text, plain = false) {
      await page.evaluate((text) => navigator.clipboard.writeText(text), text);
      await page.keyboard.press(plain ? "Control+Shift+V" : "Control+V");
    }
    const source = await openBlank("A calmer weekly handover");
    const markdown = `# Weekly brief

A **clear plan**, _small details_, ~~old assumptions~~ and \`useful context\`.

## Next steps

- [x] Align the team
- [ ] Review the release

| Area | Owner |
| --- | --- |
| Experience | Design studio |
| Delivery | Product team |

> Make the next person's work easier.

#### Reference

[Jump to next steps](#next-steps) · [Project website](https://example.com)

---

\`\`\`js
const nextStep = "Keep it clear";
\`\`\`

Ready to share.`;
    await paste(markdown);
    await expect(doc.locator("h1")).toHaveAttribute(
      "aria-label",
      "Weekly brief",
    );
    await expect(doc.locator("h2")).toHaveAttribute("aria-label", "Next steps");
    await expect(doc.locator("h4")).toHaveAttribute("aria-label", "Reference");
    await expect(doc.locator("strong")).toHaveText("clear plan");
    await expect(doc.locator("em")).toHaveText("small details");
    await expect(doc.locator("s")).toHaveText("old assumptions");
    await expect(doc.locator('li[data-type="taskItem"]')).toHaveCount(2);
    await expect(doc.locator('li[data-checked="true"]')).toHaveCount(1);
    await expect(doc.locator("table tr")).toHaveCount(3);
    await expect(doc.locator("blockquote")).toHaveText(
      "Make the next person's work easier.",
    );
    await expect(doc.locator("hr")).toHaveCount(1);
    await expect(doc.locator("pre code")).toContainText(
      'const nextStep = "Keep it clear";',
    );
    const headingId = await doc.locator("h2").getAttribute("id");
    await expect(
      doc.getByRole("link", { name: "Jump to next steps", exact: true }),
    ).toHaveAttribute("href", "?page=" + source.id + "#" + headingId);
    await page.keyboard.press("Control+Z");
    await expect(doc.locator("h1")).toHaveCount(0);
    await expect(doc).toHaveText("");
    await page.keyboard.press("Control+Shift+Z");
    await expect(doc.locator("h1")).toHaveAttribute(
      "aria-label",
      "Weekly brief",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/markdown-paste.png",
      fullPage: true,
    });

    const reader = await session(viewer);
    await reader.goto(base + "/?page=" + source.id);
    const readerDoc = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readerDoc).toHaveAttribute("contenteditable", "false");
    await expect(readerDoc.locator("h2")).toHaveAttribute(
      "aria-label",
      "Next steps",
    );
    await doc.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await paste(markdown);
    await expect(doc.locator("h2")).toHaveCount(2);
    const ids = await doc
      .locator("h2")
      .evaluateAll((nodes) => nodes.map((node) => node.id));
    assert.equal(new Set(ids).size, 2);
    const links = await doc
      .getByRole("link", { name: "Jump to next steps", exact: true })
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
    assert.deepEqual(
      links,
      ids.map((id) => "?page=" + source.id + "#" + id),
    );
    await expect(readerDoc.locator("h2")).toHaveCount(2);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(doc.locator("h2")).toHaveCount(2);

    await openBlank("Literal clipboard");
    await paste("## Keep this raw\n\n**No formatting**", true);
    await expect(doc).toContainText("## Keep this raw");
    await expect(doc).toContainText("**No formatting**");
    await expect(doc.locator("h2, strong")).toHaveCount(0);

    await openBlank("Code clipboard");
    await page.keyboard.type("/Code block");
    await page.getByRole("option", { name: "Code block", exact: true }).click();
    await paste("# keep raw\n**inside code**");
    await expect(doc.locator("pre code")).toHaveText(
      "# keep raw\n**inside code**",
    );
    await expect(doc.locator("h1, strong")).toHaveCount(0);

    await openBlank("Rich clipboard");
    await page.evaluate(async () => {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob(["## literal heading"], {
            type: "text/plain",
          }),
          "text/html": new Blob(
            ["<p><strong>## literal heading</strong></p>"],
            { type: "text/html" },
          ),
        }),
      ]);
    });
    await page.keyboard.press("Control+V");
    await expect(doc.locator("strong")).toHaveText("## literal heading");
    await expect(doc.locator("h2")).toHaveCount(0);

    await openBlank("Inline clipboard");
    await page.keyboard.insertText("Before target after");
    await page.evaluate(() => {
      const text = document.querySelector(
        '[aria-label="Document"] p',
      ).firstChild;
      const range = document.createRange();
      range.setStart(text, 7);
      range.setEnd(text, 13);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await paste("**bold** and _quiet_");
    await expect(doc).toHaveText("Before bold and quiet after");
    await expect(doc.locator("strong")).toHaveText("bold");
    await expect(doc.locator("em")).toHaveText("quiet");

    await openBlank("Safe clipboard");
    await paste(
      "# Safe paste\n\n[Unsafe](javascript:alert(1))\n\n<script>window.__markdownExecuted=true</script>",
    );
    await expect(doc.locator("h1")).toHaveAttribute("aria-label", "Safe paste");
    await expect(doc.locator('a[href^="javascript:"]')).toHaveCount(0);
    assert.equal(
      await page.evaluate(() => window.__markdownExecuted),
      undefined,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});
