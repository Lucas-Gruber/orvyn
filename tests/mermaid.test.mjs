import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { importMarkdown } from "../packages/editor/dist/markdown.js";
import { exportMarkdown } from "../packages/editor/dist/markdown-export.js";
import {
  documentToYDoc,
  yDocToDocument,
} from "../packages/editor/dist/index.js";

test("Mermaid stays native editable code through Markdown and collaborative document round-trips", () => {
  const source = "flowchart LR\n  A[An idea] --> B[A shared plan]";
  const imported = importMarkdown("```mermaid\n" + source + "\n```", {
    filename: "diagram.md",
    titleFromHeading: false,
  });
  const block = imported.document.content[0];
  assert.equal(block.type, "codeBlock");
  assert.equal(block.attrs.language, "mermaid");
  assert.equal(block.content[0].text, source);
  const document = documentToYDoc(imported.document);
  try {
    assert.deepEqual(yDocToDocument(document), imported.document);
  } finally {
    document.destroy();
  }
  const exported = exportMarkdown(imported.document, {
    title: "A diagram",
    pageUrl: "https://orvyn.example/?page=" + randomUUID(),
    page: () => undefined,
    file: () => undefined,
    person: () => undefined,
    includePeopleNames: false,
  });
  assert.ok(exported.markdown.includes("```mermaid\n" + source + "\n```"));
  assert.deepEqual(exported.warnings, []);
});

test("Chromium: Mermaid slash blocks render, edit, collaborate, recover, publish and preserve sandbox isolation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const errors = [],
    external = [];
  let page;
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
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    if (account)
      await context.addCookies([
        {
          name: "orvyn_session",
          value: account.cookie.split("=")[1],
          url: base,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
    const result = await context.newPage();
    result.on("pageerror", (error) => errors.push(error.message));
    result.on("request", (request) => {
      if (
        /^https?:/.test(request.url()) &&
        new URL(request.url()).origin !== new URL(base).origin
      )
        external.push(request.url());
    });
    return result;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account("Mara Keller"),
      viewer = await account("Jonas Weber");
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
    const source = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "From an idea to a shared plan" },
      })
    ).data;
    page = await session(owner);
    await page.goto(base + "/?page=" + source.id);
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await doc.click();
    await page.keyboard.type("/mermaid");
    const command = page.getByRole("option", { name: "Mermaid", exact: true });
    await expect(command).toBeVisible();
    await command.click();
    const block = doc.locator(".mermaid-block");
    const preview = block.locator(".mermaid-preview");
    await expect(preview).toHaveAttribute("data-render-state", "ready", {
      timeout: 20000,
    });
    const frame = page.frameLocator('iframe[title="Mermaid diagram"]');
    await expect(frame.locator("svg")).toBeVisible();
    await expect(frame.locator("#diagram")).toContainText("Collect ideas");
    await expect(block.locator(":scope > pre")).toBeHidden();
    await block
      .getByRole("button", { name: "Edit diagram", exact: true })
      .click();
    const code = block.locator(":scope > pre code");
    await expect(code).toBeEditable();
    const diagram =
      "flowchart LR\n  Brief[Project brief] --> Explore[Explore options]\n  Explore --> Review{Ready to share?}\n  Review -->|Yes| Share[Share the plan]\n  Review -->|Refine| Explore";
    async function replaceCode(value) {
      await doc.evaluate((element) => {
        const editor = element.editor;
        editor.commands.setTextSelection({
          from: 1,
          to: editor.state.doc.firstChild.nodeSize - 1,
        });
        editor.view.focus();
      });
      await page.evaluate(
        (value) => navigator.clipboard.writeText(value),
        value,
      );
      await page.keyboard.press("Control+V");
      await expect
        .poll(() =>
          doc.evaluate(
            (element) => element.editor.state.doc.firstChild.textContent,
          ),
        )
        .toBe(value);
    }
    // Exercise real typing and native clipboard paste, rather than replacing
    // the NodeView's content DOM through a synthetic contenteditable fill.
    await page.keyboard.type("X");
    await expect
      .poll(() =>
        doc.evaluate((element) =>
          element.editor.state.doc.firstChild.textContent.startsWith("X"),
        ),
      )
      .toBe(true);
    await replaceCode(diagram);
    await expect(frame.locator("#diagram")).toContainText("Project brief");
    await expect(preview).toHaveAttribute("data-render-state", "ready");
    await block
      .getByRole("button", { name: "Copy Mermaid code", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      diagram,
    );
    await block
      .getByRole("button", { name: "Hide source", exact: true })
      .click();
    await expect(block.locator(":scope > pre")).toBeHidden();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/ui-review/mermaid-dark.png",
      fullPage: true,
    });
    const beforeTheme = await frame
      .locator(".node rect")
      .first()
      .evaluate((element) => getComputedStyle(element).fill);
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await expect.poll(() => frame.locator("svg").textContent()).not.toBe("");
    await expect(frame.locator("svg")).toBeVisible();
    await expect
      .poll(() =>
        frame
          .locator(".node rect")
          .first()
          .evaluate((element) => getComputedStyle(element).fill),
      )
      .not.toBe(beforeTheme);
    await expect(preview).toHaveAttribute("data-render-state", "ready");
    await page.screenshot({
      path: ".local/ui-review/mermaid-light.png",
      fullPage: true,
    });

    const reader = await session(viewer);
    await reader.goto(base + "/?page=" + source.id);
    const readerDoc = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readerDoc).toHaveAttribute("contenteditable", "false");
    await expect(readerDoc.locator(".mermaid-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 20000 },
    );
    await reader
      .getByRole("button", { name: "Show source", exact: true })
      .click();
    assert.equal(
      await readerDoc
        .locator("pre code")
        .evaluate((element) => element.isContentEditable),
      false,
    );
    await expect(readerDoc.locator("pre code")).toHaveText(diagram);
    await expect(
      reader.getByLabel("Code language", { exact: true }),
    ).toBeDisabled();
    await block
      .getByRole("button", { name: "Edit diagram", exact: true })
      .click();
    await replaceCode("flowchart LR\n  A[Shared brief] --> B[Review together]");
    await expect(
      reader
        .frameLocator('iframe[title="Mermaid diagram"]')
        .locator("#diagram"),
    ).toContainText("Shared brief");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(preview).toHaveAttribute("data-render-state", "ready", {
      timeout: 20000,
    });
    await expect(frame.locator("#diagram")).toContainText("Shared brief");

    // A renderer can neither read its parent's authenticated DOM nor make API
    // requests, even when executed from inside the iframe context.
    const isolated = await (
      await block.locator("iframe").elementHandle()
    ).contentFrame();
    assert.equal(
      await isolated.evaluate(() => {
        try {
          return parent.document.body.textContent;
        } catch (error) {
          return error.name;
        }
      }),
      "SecurityError",
    );
    assert.equal(
      await isolated.evaluate(async (base) => {
        try {
          await fetch(base + "/api/v1/auth/me");
          return "allowed";
        } catch {
          return "blocked";
        }
      }, base),
      "blocked",
    );
    await expect(block.locator("iframe")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    await block
      .getByRole("button", { name: "Edit diagram", exact: true })
      .click();
    await replaceCode("this is not a Mermaid diagram");
    await expect(preview).toHaveAttribute("data-render-state", "error");
    await expect(code).toHaveText("this is not a Mermaid diagram");
    await page.evaluate(() =>
      window.postMessage({ type: "orvyn-mermaid-rendered", sequence: 1 }, "*"),
    );
    await expect(preview).toHaveAttribute("data-render-state", "error");
    await replaceCode(
      "sequenceDiagram\n  participant Team\n  participant Orvyn\n  Team->>Orvyn: Share an idea\n  Orvyn-->>Team: Keep everyone in sync",
    );
    await expect(preview).toHaveAttribute("data-render-state", "ready");
    await expect(frame.locator("#diagram")).toContainText(
      "Keep everyone in sync",
    );
    const attack =
      '%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"@import url(https://example.invalid/diagram-style);"}}%%\nflowchart LR\n A["<img src=https://example.invalid/diagram-image onerror=parent.__mermaidExecuted=true>"] --> B[Safe node]\n click B "https://example.invalid/diagram-click"';
    await replaceCode(attack);
    await expect(preview).not.toHaveAttribute("data-render-state", "loading", {
      timeout: 20000,
    });
    assert.equal(
      await page.evaluate(() => window.__mermaidExecuted),
      undefined,
    );
    assert.deepEqual(external, []);
    const largeDiagram = "flowchart LR\n A[Stored code]" + " ".repeat(21000);
    await replaceCode(largeDiagram);
    await expect(preview).toHaveAttribute("data-render-state", "error");
    await expect(preview).toContainText("20,000 characters");
    await expect(code).toHaveText(largeDiagram);
    const publishedDiagram =
      "sequenceDiagram\n  participant Team\n  participant Orvyn\n  Team->>Orvyn: Share an idea\n  Orvyn-->>Team: Keep everyone in sync";
    await replaceCode(publishedDiagram);
    await expect(preview).toHaveAttribute("data-render-state", "ready");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const input = {
      scope: { pageIds: [], databases: [], extraFileIds: [] },
      settings: {
        label: "Working together",
        passwordProtected: false,
        indexable: false,
        expiresAt: null,
      },
      target: null,
    };
    const path = `pages/${source.id}/publications`;
    const review = await request(path + "/preview", {
      method: "POST",
      cookie: owner.cookie,
      body: input,
    });
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const published = await request(path, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
        input,
      },
    });
    assert.equal(
      published.response.status,
      201,
      JSON.stringify(published.data),
    );
    const anonymous = await session();
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
    ).toContainText("Keep everyone in sync");
    await anonymous.getByText("Mermaid source", { exact: true }).click();
    await expect(anonymous.locator(".public-mermaid pre code")).toHaveText(
      publishedDiagram,
    );
    const pastedPage = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Diagrams from Markdown" },
      })
    ).data;
    await page.goto(base + "/?page=" + pastedPage.id);
    await expect(doc).toBeEditable();
    await doc.click();
    await page.evaluate(
      (source) => navigator.clipboard.writeText(source),
      "```mermaid\nflowchart LR\n A[One idea] --> B[One team]\n```\n\n```mermaid\n" +
        publishedDiagram +
        "\n```",
    );
    await page.keyboard.press("Control+V");
    const previews = doc.locator(".mermaid-preview");
    await expect(previews).toHaveCount(2);
    await expect
      .poll(
        () =>
          previews.evaluateAll((nodes) =>
            nodes.map((node) => node.dataset.renderState),
          ),
        { timeout: 20000 },
      )
      .toEqual(["ready", "ready"]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= 390),
    );
    await expect(previews.nth(0)).toHaveAttribute("data-render-state", "ready");
    await page.screenshot({
      path: ".local/ui-review/mermaid-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page && !page.isClosed())
      await page
        .screenshot({
          path: ".local/ui-review/mermaid-failure.png",
          fullPage: true,
        })
        .catch(() => {});
    throw error;
  } finally {
    await browser.close();
    await db.end();
  }
});
