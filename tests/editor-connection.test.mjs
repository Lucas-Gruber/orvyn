import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";

async function fixture() {
  const registration = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(registration.response);
  const space = (
    await request("spaces", {
      method: "POST",
      cookie,
      body: { name: "Connection recovery" },
    })
  ).data;
  let source = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title: "Priorisierte Verbesserungs-Roadmap (P0–P3)" },
    })
  ).data;
  source = (
    await request(`pages/${source.id}`, {
      method: "PUT",
      cookie,
      body: {
        title: source.title,
        version: source.version,
        document: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2, id: randomUUID() },
              content: [{ type: "text", text: "P0 — Verlässliches Speichern" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Diese gespeicherte Seite bleibt auch ohne Live-Verbindung lesbar.",
                },
              ],
            },
          ],
        },
      },
    })
  ).data;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([
    { name: "orvyn_session", value: cookie.split("=")[1], url: base },
  ]);
  return { browser, context, cookie, source, space };
}

test("Chromium: a stalled initial handshake shows saved content and reconnect, and never blocks unedited navigation", async () => {
  const f = await fixture();
  let blocked = true;
  try {
    const page = await f.context.newPage();
    await page.routeWebSocket("**/collaboration", (route) => {
      if (blocked) route.onMessage(() => {});
      else route.connectToServer();
    });
    await page.goto(base + "/?page=" + f.source.id);
    const preview = page.getByRole("document", {
      name: "Saved document preview",
    });
    await expect(preview).toContainText("Verlässliches Speichern");
    await expect(preview).not.toHaveAttribute("contenteditable", "true");
    await expect(
      page.getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/editor-connection-recovery.png",
    });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".space-home")).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByText(/Document changes are still waiting to save/),
    ).toHaveCount(0);
    await page.goto(base + "/?page=" + f.source.id);
    await expect(
      page.getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeVisible();
    blocked = false;
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await expect(doc.locator("h2")).toHaveCount(1);
    await expect(preview).toHaveCount(0);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("Chromium: interrupted local changes stay protected, reconnect durably and never duplicate the saved snapshot", async () => {
  const f = await fixture();
  let outage = false,
    socket;
  try {
    const page = await f.context.newPage();
    await page.routeWebSocket("**/collaboration", (route) => {
      socket = route;
      if (outage) route.onMessage(() => {});
      else {
        const server = route.connectToServer();
        route.onMessage((message) => {
          if (!outage) server.send(message);
        });
      }
    });
    await page.goto(base + "/?page=" + f.source.id);
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    outage = true;
    await doc.locator("p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Local changes survive.");
    await socket.close({ code: 1013, reason: "Temporary test interruption" });
    await expect(doc).not.toBeEditable();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(
      page.getByText(
        "Document changes are still waiting to save. Reconnect before leaving this page.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(doc).toContainText("Local changes survive.");
    outage = false;
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(doc).toBeEditable();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const saved = (await request(`pages/${f.source.id}`, { cookie: f.cookie }))
      .data;
    assert.ok(
      JSON.stringify(saved.document).includes("Local changes survive."),
    );
    assert.equal(
      saved.document.content.filter((node) => node.type === "heading").length,
      1,
    );
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});
