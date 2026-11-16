import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { request, sessionCookie, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";

test("Chromium: rapid typing batches transport, durably acknowledges complete content and flushes before navigation", async () => {
  const registration = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registration.response),
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Writing workspace" },
      })
    ).data,
    source = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie,
        body: { title: "Fast writing" },
      })
    ).data,
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
  const context = await browser.newContext(),
    errors = [];
  try {
    await context.addCookies([
      {
        name: "orvyn_session",
        value: cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      reader = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    reader.on("pageerror", (e) => errors.push(e.message));
    let updates = 0;
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        if (!Buffer.isBuffer(payload)) return;
        let pos = 0;
        const uint = () => {
          let value = 0,
            shift = 0,
            byte;
          do {
            byte = payload[pos++];
            value += (byte & 127) * 2 ** shift;
            shift += 7;
          } while (byte & 128);
          return value;
        };
        const length = uint(),
          address = payload.subarray(pos, pos + length).toString();
        pos += length;
        if (
          address.split("\0")[0] === source.id &&
          uint() === 0 &&
          uint() === 2
        )
          updates++;
      }),
    );
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    await reader.goto(base + pageLink(source.id));
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeEditable();
    await doc.locator(":scope > p").click();
    updates = 0;
    const text =
      "Fast writing should reach the other editor promptly and be stored before the page says it is saved. ".repeat(
        2,
      );
    await page.keyboard.type(text);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    console.log(
      `Writing transport: ${text.length} keystrokes, ${updates} durably acknowledged update frames`,
    );
    assert.ok(
      updates > 0 && updates < text.length / 2,
      `Expected batching, received ${updates} update frames for ${text.length} keystrokes`,
    );
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toContainText(text.trim());
    let saved = (await request(`pages/${source.id}`, { cookie })).data;
    assert.equal(
      saved.document.content
        .map((n) => (n.content || []).map((c) => c.text || "").join(""))
        .join(""),
      text,
    );
    const tail = "Saved when leaving immediately.";
    await page.keyboard.type(tail);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".space-home")).toBeVisible();
    saved = (await request(`pages/${source.id}`, { cookie })).data;
    assert.equal(
      saved.document.content
        .map((n) => (n.content || []).map((c) => c.text || "").join(""))
        .join(""),
      text + tail,
    );
    await page.goto(base + pageLink(source.id));
    await expect(doc).toContainText(text + tail);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
