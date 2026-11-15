import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { base } from "./helpers.mjs";
test("Chromium: five database views, live Kanban drag, record documents and saved filters", async () => {
  const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  const space = "Data space " + randomUUID().slice(0, 8),
    database = "Project database " + randomUUID().slice(0, 8),
    title = "Build foundation";
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base);
    await page
      .getByLabel("Email", { exact: true })
      .fill(randomUUID() + "@example.test");
    await page
      .getByLabel("Password · at least 12 characters", { exact: true })
      .fill(randomUUID());
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page.getByLabel("New private space", { exact: true }).fill(space);
    await page
      .getByRole("button", { name: "Create space", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New database", exact: true })
      .click();
    await page.getByLabel("Database name", { exact: true }).fill(database);
    await page
      .getByRole("button", { name: "Create database", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: database, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New record", exact: true }).click();
    await page.getByLabel("Record name", { exact: true }).fill(title);
    await page
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption({ label: "To do" });
    await page.getByLabel("Date", { exact: true }).fill("2026-11-20");
    await page
      .getByRole("button", { name: "Create record", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Live updates connected", { exact: true }),
    ).toBeVisible();
    const observer = await context.newPage();
    observer.on("pageerror", (e) => errors.push(e.message));
    await observer.goto(base);
    await observer.getByRole("button", { name: space, exact: true }).click();
    await observer.getByRole("button", { name: database, exact: true }).click();
    await expect(
      observer.getByText("Live updates connected", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const source = page
        .locator('.board-column[aria-label="To do"] article')
        .filter({ hasText: title }),
      destination = page.locator('.board-column[aria-label="In progress"]');
    await source
      .getByRole("button", { name: "Move " + title, exact: true })
      .dragTo(destination);
    await expect(
      destination.getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
    const observerRow = observer.getByRole("row").filter({
      has: observer.getByRole("button", { name: title, exact: true }),
    });
    await expect(
      observerRow
        .getByRole("combobox", { name: "Status", exact: true })
        .locator("option:checked"),
    ).toHaveText("In progress", { timeout: 3000 });
    for (const type of ["List", "Gallery"]) {
      await page.getByRole("tab", { name: type, exact: true }).click();
      await expect(
        page.getByRole("button", { name: title, exact: true }),
      ).toBeVisible();
    }
    await page.getByRole("tab", { name: "Calendar", exact: true }).click();
    await page.getByLabel("Month", { exact: true }).fill("2026-11");
    await expect(
      page
        .getByRole("gridcell", { name: "2026-11-20", exact: true })
        .getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Table", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page
      .getByRole("textbox", { name: "Document", exact: true })
      .fill("This record is also a real document.");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to database", exact: true })
      .click();
    await page.locator("summary").filter({ hasText: "Add a property" }).click();
    await page.getByLabel("Property name", { exact: true }).fill("Estimate");
    await page
      .getByLabel("Property type", { exact: true })
      .selectOption({ label: "Number" });
    await page
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    const row = () =>
      page.getByRole("row").filter({
        has: page.getByRole("button", { name: title, exact: true }),
      });
    await row()
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("8");
    await row()
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Tab");
    await expect(
      row().getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("8");
    await page
      .getByRole("button", { name: "View settings", exact: true })
      .click();
    const settings = page.locator("form.database-form").filter({
      has: page.getByRole("heading", { name: "View settings", exact: true }),
    });
    await settings
      .getByRole("button", { name: "Add filter", exact: true })
      .click();
    await settings
      .getByRole("combobox", { name: "Filter property", exact: true })
      .selectOption({ label: "Estimate" });
    await settings
      .getByRole("combobox", { name: "Filter comparison", exact: true })
      .selectOption("gt");
    await settings
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("5");
    await settings
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Tab");
    await settings
      .getByRole("button", { name: "Save view", exact: true })
      .click();
    await expect(
      row().getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toBeVisible();
    await row()
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("1");
    // A committed update arrives while this local input is still focused.
    const remote = await page.evaluate(
      async ({ space, database, title }) => {
        const get = async (path, body) =>
          (
            await fetch("/api/v1/" + path, {
              method: body ? "POST" : "GET",
              headers: { "Content-Type": "application/json" },
              body: body ? JSON.stringify(body) : undefined,
            })
          ).json();
        const source = (await get("spaces")).find((s) => s.name === space);
        const db = (await get("spaces/" + source.id + "/databases")).find(
          (d) => d.title === database,
        );
        const record = (
          await get("databases/" + db.id + "/query", {})
        ).records.find((r) => r.title === title);
        return { id: db.id, record };
      },
      { space, database, title },
    );
    const refresh = page.waitForResponse(
      (response) =>
        response.url().includes("/databases/" + remote.id + "/query") &&
        response.request().method() === "POST",
    );
    await page.evaluate(async ({ id, record }) => {
      const response = await fetch(
        "/api/v1/databases/" + id + "/records/" + record.pageId,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: record.version, values: {} }),
        },
      );
      if (!response.ok) throw Error("Concurrent update failed");
    }, remote);
    await refresh;
    await expect(
      page.getByText("Loading records…", { exact: true }),
    ).toHaveCount(0);
    await expect(
      row().getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("1");
    await row()
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Tab");
    await expect(
      page.getByRole("button", { name: title, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveText("This record is also a real document.");
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Database browser errors:", errors);
    console.error(
      "Database browser visible text:",
      await page.locator("body").innerText(),
    );
    await page.screenshot({ path: "/tmp/orvyn-database-browser-failure.png" });
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
});
