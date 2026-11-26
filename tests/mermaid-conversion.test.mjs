import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";

test("Chromium: recognizable unlabelled Mermaid code converts in one undoable action and renders after reload and publication", async () => {
  const registered = await request("auth/register", {
    method: "POST",
    body: {
      email: randomUUID() + "@example.test",
      password: randomUUID(),
      displayName: "Mara Keller",
    },
  });
  const cookie = sessionCookie(registered.response);
  const space = (
    await request("spaces", {
      method: "POST",
      cookie,
      body: { name: "Product studio" },
    })
  ).data;
  const source = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title: "From code to a clear diagram" },
    })
  ).data;
  const code =
    "%% A shared decision\nflowchart LR\n  Idea[Collect ideas] --> Plan[Make a plan]\n  Plan --> Review{Ready to share?}\n  Review -->|Yes| Share[Build together]\n  Review -->|Refine| Plan";
  const other = "const flowchart = 'Keep ordinary code as code';";
  const block = (text, language) => ({
    type: "codeBlock",
    attrs: { language },
    content: [{ type: "text", text }],
  });
  assert.equal(
    (
      await request(`pages/${source.id}`, {
        method: "PUT",
        cookie,
        body: {
          title: source.title,
          version: source.version,
          document: {
            type: "doc",
            content: [
              block(code, "plaintext"),
              block(code, "javascript"),
              block(other, "plaintext"),
            ],
          },
        },
      })
    ).response.status,
    200,
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  });
  const errors = [];
  try {
    await context.addCookies([
      { name: "orvyn_session", value: cookie.split("=")[1], url: base },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/?page=" + source.id);
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    const convert = doc.getByRole("button", {
      name: "Render diagram",
      exact: true,
    });
    await expect(convert).toHaveCount(1);
    await convert.click();
    const diagram = doc.locator(".mermaid-block");
    await expect(diagram.locator(".mermaid-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 20000 },
    );
    await expect(diagram.locator(":scope > pre")).toBeHidden();
    await expect(
      page.frameLocator('iframe[title="Mermaid diagram"]').locator("#diagram"),
    ).toContainText("Build together");
    await expect(doc.locator(".code-block")).toHaveCount(3);
    await expect(
      doc
        .locator(".code-block")
        .nth(1)
        .getByLabel("Code language", { exact: true }),
    ).toHaveValue("javascript");
    await page.keyboard.press("Control+z");
    await expect(convert).toHaveCount(1);
    await expect(doc.locator(".mermaid-block")).toHaveCount(0);
    await expect(doc.locator("pre code").first()).toHaveText(code);
    await page.keyboard.press("Control+Shift+z");
    await expect(diagram.locator(".mermaid-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 20000 },
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const saved = (await request(`pages/${source.id}`, { cookie })).data;
    assert.equal(saved.document.content[0].attrs.language, "mermaid");
    assert.equal(saved.document.content[0].content[0].text, code);
    assert.equal(saved.document.content[1].attrs.language, "javascript");
    assert.equal(saved.document.content[2].attrs.language, "plaintext");
    assert.equal(saved.document.content[2].content[0].text, other);
    await page.reload();
    await expect(diagram.locator(".mermaid-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 20000 },
    );
    await expect(diagram.locator(":scope > pre")).toBeHidden();
    await mkdir(".local/ui-review", { recursive: true });
    // Remove the comparison examples through a real document transaction for
    // the final shared page; the converted diagram itself stays unchanged.
    await doc.evaluate((element) => {
      const editor = element.editor;
      editor.commands.deleteRange({
        from: editor.state.doc.firstChild.nodeSize,
        to: editor.state.doc.content.size,
      });
    });
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/ui-review/mermaid-issue-rendered.png",
    });
    const input = {
      scope: { pageIds: [], databases: [], extraFileIds: [] },
      settings: {
        label: "From code to a clear diagram",
        passwordProtected: false,
        indexable: false,
        expiresAt: null,
      },
      target: null,
    };
    const path = `pages/${source.id}/publications`;
    const review = await request(path + "/preview", {
      method: "POST",
      cookie,
      body: input,
    });
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const published = await request(path, {
      method: "POST",
      cookie,
      body: {
        input,
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
      },
    });
    assert.equal(
      published.response.status,
      201,
      JSON.stringify(published.data),
    );
    const reader = await browser.newContext();
    try {
      const anonymous = await reader.newPage();
      await anonymous.goto(published.data.url);
      await expect(anonymous.locator(".mermaid-preview")).toHaveAttribute(
        "data-render-state",
        "ready",
        { timeout: 20000 },
      );
      await expect(
        anonymous
          .frameLocator('iframe[title="Mermaid diagram"]')
          .locator("#diagram"),
      ).toContainText("Build together");
      await expect(
        anonymous.getByRole("button", { name: "Render diagram", exact: true }),
      ).toHaveCount(0);
    } finally {
      await reader.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
