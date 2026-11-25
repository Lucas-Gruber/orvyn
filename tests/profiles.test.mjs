import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { accountSettings } from "./ui-helpers.mjs";
import { profileName, oidcProfileName } from "../packages/shared/dist/index.js";

test("profile labels reject email addresses and hidden controls, support Unicode and use OIDC username fallback", () => {
  assert.equal(profileName("  Zoë   Müller  "), "Zoë Müller");
  assert.equal(profileName("e\u0301"), "é");
  for (const value of [
    null,
    {},
    " ",
    "secret@example.test",
    "a".repeat(81),
    "a\nname",
    "a\u202Ename",
  ])
    assert.equal(profileName(value), null);
  assert.equal(
    oidcProfileName({ name: "Taylor Quinn", preferred_username: "tquinn" }),
    "Taylor Quinn",
  );
  assert.equal(
    oidcProfileName({
      name: "private@example.test",
      preferred_username: "tquinn",
    }),
    "tquinn",
  );
  assert.equal(
    oidcProfileName({ preferred_username: "private@example.test" }),
    null,
  );
});

async function account(displayName) {
  const email = randomUUID() + "@example.test";
  const result = await request("auth/register", {
    method: "POST",
    body: {
      email,
      password: randomUUID(),
      ...(displayName ? { displayName } : {}),
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  const cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}

test("profiles change only the authenticated account, keep identities and resolve historical mention names without disclosing email", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account("Mara Keller"),
      reader = await account("Alex Morgan"),
      other = await account();
    assert.equal(other.displayName, other.email.split("@")[0]);
    assert.equal(
      (
        await request("auth/profile", {
          method: "PATCH",
          body: { displayName: "Anonymous" },
        })
      ).response.status,
      401,
    );
    for (const body of [
      { displayName: "" },
      { displayName: reader.email },
      { displayName: "Other", id: reader.id },
      { displayName: "Other", email: reader.email },
      { displayName: "Other", isAdmin: true },
      { displayName: "\u202EAdmin" },
    ]) {
      assert.equal(
        (
          await request("auth/profile", {
            method: "PATCH",
            cookie: owner.cookie,
            body,
          })
        ).response.status,
        400,
      );
    }
    assert.equal(
      (
        await request("auth/profile", {
          method: "PATCH",
          cookie: owner.cookie,
          origin: "https://untrusted.example.test",
          body: { displayName: "Injected" },
        })
      ).response.status,
      403,
    );
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Design team" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      reader.id,
    ]);
    const page = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Launch review" },
      })
    ).data;
    const created = await request(`pages/${page.id}/threads`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        body: "Please review this, @Alex Morgan.",
        mentions: [reader.id],
        requestId: randomUUID(),
      },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.messages[0].author, {
      id: owner.id,
      displayName: "Mara Keller",
    });
    const result = await request("auth/profile", {
      method: "PATCH",
      cookie: reader.cookie,
      body: { displayName: "  Alex   Chen  " },
    });
    assert.equal(result.response.status, 200);
    const me = (await request("auth/me", { cookie: reader.cookie })).data;
    assert.equal(me.id, reader.id);
    assert.equal(me.email, reader.email);
    assert.equal(me.displayName, "Alex Chen");
    const detail = (
      await request(`threads/${created.data.thread.id}`, {
        cookie: owner.cookie,
      })
    ).data;
    assert.equal(detail.messages[0].body, "Please review this, @Alex Chen.");
    assert.deepEqual(detail.messages[0].mentions, [
      { id: reader.id, displayName: "Alex Chen" },
    ]);
    assert.equal(detail.thread.preview, "Please review this, @Alex Chen.");
    const message = detail.messages[0];
    const edited = await request(`comments/${message.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        body: message.body + " Thank you!",
        version: message.version,
        mentions: [reader.id],
      },
    });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
    const directory = (
      await request(`spaces/${space.id}/directory`, { cookie: owner.cookie })
    ).data;
    assert.ok(
      directory.some(
        (p) => p.id === reader.id && p.displayName === "Alex Chen",
      ),
    );
    assert.ok(!JSON.stringify(directory).includes("@"));
    const alerts = (await request("notifications", { cookie: reader.cookie }))
      .data;
    assert.equal(alerts.notifications[0].actor.displayName, "Mara Keller");
    assert.equal(
      alerts.unread,
      1,
      "renaming and editing must not send a second notification",
    );
    const hidden = await request(`spaces/${space.id}/directory`, {
      cookie: other.cookie,
    });
    assert.equal(hidden.response.status, 404);
    // Legacy comment mentions store an email-shaped text label, not a new identity.
    await db.query("UPDATE comments SET body=$2 WHERE id=$1", [
      message.id,
      `Legacy @${reader.email}.`,
    ]);
    await db.query(
      "UPDATE comment_mentions SET label=$3 WHERE comment_id=$1 AND user_id=$2",
      [message.id, reader.id, reader.email],
    );
    const legacy = (
      await request(`threads/${created.data.thread.id}`, {
        cookie: owner.cookie,
      })
    ).data;
    assert.equal(legacy.messages[0].body, "Legacy @Alex Chen.");
    assert.ok(!JSON.stringify(legacy).includes(reader.email));
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [space.id, reader.id],
    );
    const former = (
      await request(`threads/${created.data.thread.id}`, {
        cookie: owner.cookie,
      })
    ).data;
    assert.equal(former.messages[0].body, "Legacy @Former member.");
    assert.equal(former.messages[0].mentions[0].displayName, null);
  } finally {
    await db.end();
  }
});

test("Chromium: edit a display name, persist it across reloads and show it in the account menu", async () => {
  const user = await account("Mara Keller");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
      locale: "en-GB",
      timezoneId: "Europe/Berlin",
    });
    await page
      .context()
      .addCookies([
        { name: "orvyn_session", value: user.cookie.split("=")[1], url: base },
      ]);
    await page.goto(base);
    await expect(
      page.getByRole("button", { name: "Account menu", exact: true }),
    ).toContainText("Mara Keller");
    await accountSettings(page);
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Mara · Design");
    await page
      .getByRole("button", { name: "Save display name", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("Display name saved.");
    await expect(
      page.getByRole("button", { name: "Account menu", exact: true }),
    ).toContainText("Mara · Design");
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({
      path: ".local/screenshots/display-name-profile.png",
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Account menu", exact: true }),
    ).toContainText("Mara · Design");
    assert.ok(
      !(await page.locator(".app-sidebar").innerText()).includes(user.email),
    );
  } finally {
    await browser.close();
  }
});
