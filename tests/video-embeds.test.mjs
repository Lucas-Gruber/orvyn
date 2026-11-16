import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
test("Chromium: embeds persist without external requests until consent, sandbox players and keep reader load state local", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [],
    external = [];
  let page;
  async function account() {
    const r = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
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
    p.on("request", (r) => {
      if (new URL(r.url()).hostname.includes("youtube")) external.push(r);
    });
    await p.route("https://www.youtube-nocookie.com/embed/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Fixture player</title><p>Player fixture loaded</p>",
      }),
    );
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
          body: { name: "Video documentation" },
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
        body: { title: "Review walkthrough" },
      })
    ).data;
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await doc.click();
    await page.keyboard.type("/embed");
    await page.getByRole("option", { name: "Embed", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Insert video embed",
      exact: true,
    });
    await picker
      .getByLabel("Video URL", { exact: true })
      .fill("https://127.0.0.1/private");
    await picker
      .getByRole("button", { name: "Insert embed", exact: true })
      .click();
    await expect(picker.getByRole("alert")).toContainText(
      "Use a public HTTPS video link",
    );
    await picker
      .getByLabel("Video URL", { exact: true })
      .fill("https://youtu.be/AbCdEf012_-");
    await picker
      .getByLabel("Video title (optional)", { exact: true })
      .fill("Release review video");
    await picker
      .getByRole("button", { name: "Insert embed", exact: true })
      .click();
    await expect(
      doc.getByText("Release review video", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    assert.equal(external.length, 0);
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.screenshot({
      path: ".local/ui-review/video-embed.png",
      fullPage: true,
    });
    const before = (
      await request("pages/" + source.id, { cookie: owner.cookie })
    ).data.version;
    await doc.getByRole("button", { name: "Load video", exact: true }).click();
    const frame = page.locator("iframe");
    await expect(frame).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/AbCdEf012_-",
    );
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-presentation",
    );
    await expect(
      page.frameLocator("iframe").getByText("Player fixture loaded"),
    ).toBeVisible();
    assert.equal(external.length, 1);
    assert.equal(external[0].headers().referer, undefined);
    assert.equal(
      (await request("pages/" + source.id, { cookie: owner.cookie })).data
        .version,
      before,
    );
    await doc
      .getByRole("button", { name: "Unload video", exact: true })
      .click();
    await expect(frame).toHaveCount(0);
    await page.reload();
    await expect(
      doc.getByRole("button", { name: "Load video", exact: true }),
    ).toBeVisible();
    assert.equal(external.length, 1);
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveAttribute("contenteditable", "false");
    await expect(
      reader.getByRole("button", { name: "Remove video embed", exact: true }),
    ).toHaveCount(0);
    assert.equal(external.length, 1);
    await reader
      .getByRole("button", { name: "Load video", exact: true })
      .click();
    await expect(
      reader.frameLocator("iframe").getByText("Player fixture loaded"),
    ).toBeVisible();
    assert.equal(external.length, 2);
    assert.equal(
      (await request("pages/" + source.id, { cookie: owner.cookie })).data
        .version,
      before,
    );
    await page
      .getByRole("button", { name: "Remove video embed", exact: true })
      .click();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await expect(reader.locator("iframe")).toHaveCount(0);
    assert.deepEqual(errors, []);
  } catch (e) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/video-embed-failure.png",
        fullPage: true,
      });
    console.error("Video browser errors", errors);
    throw e;
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await db.end();
  }
});
