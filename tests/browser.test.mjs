import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "./browser-tools.mjs";
import {
  chooseSpace,
  openPageFromSidebar,
  accountSettings,
  showAttachments,
} from "./ui-helpers.mjs";
import { Pool, base, waitForMail, emailToken } from "./helpers.mjs";
test("Chromium: account, persisted page, verification, session settings and OIDC administration", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const email = randomUUID() + "@example.test",
    password = randomUUID(),
    space = "Browser space " + randomUUID().slice(0, 8);
  try {
    await page.goto(base);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page
      .getByLabel("Password · at least 12 characters", { exact: true })
      .fill(password);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
    await page.getByLabel("New private space", { exact: true }).fill(space);
    await page
      .getByRole("button", { name: "Create space", exact: true })
      .click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page
      .getByLabel("Page title", { exact: true })
      .fill("A real persisted page");
    await page.getByLabel("Page title", { exact: true }).press("Tab");
    await expect(page.getByText("Title saved", { exact: true })).toBeVisible();
    await page
      .getByRole("textbox", { name: "Document", exact: true })
      .fill("Written through the browser.");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await chooseSpace(page, space);
    await openPageFromSidebar(page, "A real persisted page");
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveText("Written through the browser.");
    await showAttachments(page);
    await page.getByLabel("Choose attachment", { exact: true }).setInputFiles({
      name: "browser-attachment.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Uploaded from Chromium"),
    });
    await page
      .getByRole("button", { name: "Upload attachment", exact: true })
      .click();
    await expect(
      page.getByRole("link", {
        name: "Download browser-attachment.txt",
        exact: true,
      }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("link", {
        name: "Download browser-attachment.txt",
        exact: true,
      })
      .click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "browser-attachment.txt");
    await page
      .getByRole("button", { name: "Space settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Pages that will stay restricted",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Confirm conversion to a team space",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    const token = emailToken(
      await waitForMail(email, "Verify your Orvyn email"),
    );
    await page.goto(
      base + "/#" + new URLSearchParams({ action: "verify-email", token }),
    );
    await expect(page).not.toHaveURL(/#/);
    await page
      .getByRole("button", { name: "Confirm email address", exact: true })
      .click();
    await accountSettings(page);
    await expect(
      page.getByText("Email verified", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("This session", { exact: true })).toBeVisible();
    const db = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await db.query(
        "UPDATE users SET is_admin=true WHERE email=$1 AND email_verified=true",
        [email],
      );
    } finally {
      await db.end();
    }
    await page.reload();
    await page
      .getByRole("button", { name: "SSO administration", exact: true })
      .click();
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Browser provider");
    await page
      .getByLabel("Issuer URL", { exact: true })
      .fill("https://id.example.test");
    await page.getByLabel("Client ID", { exact: true }).fill("browser-test");
    await page
      .getByLabel("Client secret (required for confidential clients)", {
        exact: true,
      })
      .fill(randomUUID());
    await page
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Browser provider · Disabled",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Client secret: Configured", { exact: true }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
  } catch (e) {
    console.error("Browser errors:", errors);
    console.error("Visible page:", await page.locator("body").innerText());
    await page.screenshot({ path: "/tmp/orvyn-browser-failure.png" });
    throw e;
  } finally {
    await context.close();
    await browser.close();
  }
});
