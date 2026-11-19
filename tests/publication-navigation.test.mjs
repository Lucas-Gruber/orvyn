import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import {
  publicationTree,
  publicationTrail,
} from "../apps/web/app/utils/publicationTree.ts";
const text = (value) => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
});
async function fixture() {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response),
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "A shared handbook" },
      })
    ).data;
  async function page(title, parentId = null) {
    const result = await request("spaces/" + space.id + "/pages", {
      method: "POST",
      cookie,
      body: { title, parentId },
    });
    assert.equal(result.response.status, 201);
    return result.data;
  }
  const root = await page("The handbook"),
    folder = await page("Design", root.id),
    leaf = await page("Standards", folder.id);
  return {
    cookie,
    space,
    root,
    folder,
    leaf,
    page,
    path: "pages/" + root.id + "/publications",
  };
}
async function publish(f, input) {
  const review = await request(f.path + "/preview", {
    method: "POST",
    cookie: f.cookie,
    body: input,
  });
  assert.equal(review.response.status, 201, JSON.stringify(review.data));
  const result = await request(f.path, {
    method: "POST",
    cookie: f.cookie,
    body: {
      requestId: randomUUID(),
      previewToken: review.data.previewToken,
      input,
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data;
}

test("publication hierarchy orders only approved pages, keeps ancestors local and bounds malformed parent cycles", () => {
  const page = (id, title, parentId, order = 0) => ({
    id,
    title,
    parentId,
    order,
    kind: "page",
    icon: null,
    coverPreset: null,
    coverFileId: null,
    document: { type: "doc", content: [] },
  });
  const pages = [
    page("leaf", "Standards", "folder"),
    page("root", "Handbook", null),
    page("folder", "Design", "root"),
    page("orphan", "Other", "PRIVATE-ID"),
    page("cycle-a", "Cycle A", "cycle-b"),
    page("cycle-b", "Cycle B", "cycle-a"),
  ];
  const tree = publicationTree(pages, "root");
  assert.equal(tree.length, pages.length);
  assert.equal(new Set(tree.map((entry) => entry.page.id)).size, pages.length);
  assert.ok(!JSON.stringify(tree).includes("PRIVATE-TITLE"));
  assert.equal(tree.find((entry) => entry.page.id === "leaf").depth, 2);
  assert.deepEqual(
    publicationTrail(pages, "root", "leaf").map((page) => page.id),
    ["root", "folder", "leaf"],
  );
  assert.deepEqual(publicationTrail(pages, "root", "UNKNOWN"), []);
  assert.deepEqual(publicationTree(pages, "UNKNOWN"), []);
});

test("Chromium: published hierarchy searches locally, preserves nested breadcrumbs and becomes a keyboard-usable mobile picker", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs"),
    { mkdir } = await import("node:fs/promises");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(),
      heading = randomUUID();
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.leaf.id,
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2, id: heading },
            content: [{ type: "text", text: "A clear handover" }],
          },
          text(
            "Leave the work a little easier for the next person to pick up.",
          ),
        ],
      },
    ]);
    const extra = (
      await db.query(
        "INSERT INTO pages(space_id,title,parent_id) SELECT $1,'Guide '||lpad(i::text,2,'0'),$2 FROM generate_series(1,11) i RETURNING id",
        [f.space.id, f.root.id],
      )
    ).rows;
    const input = {
        scope: {
          pageIds: [f.folder.id, f.leaf.id, ...extra.map((row) => row.id)],
          databases: [],
          extraFileIds: [],
        },
        settings: {
          label: "The handbook",
          passwordProtected: false,
          indexable: false,
          expiresAt: null,
        },
        target: null,
      },
      pub = await publish(f, input);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      requests = [],
      forbidden = [];
    await context.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (!path.startsWith("/api/v1/publications/")) {
        forbidden.push(path);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pub.url);
    const nav = page.getByRole("navigation", {
      name: "Published pages",
      exact: true,
    });
    await expect(
      nav.getByRole("link", { name: "Design", exact: true }),
    ).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Standards", exact: true }),
    ).not.toBeVisible();
    const before = requests.length;
    await nav
      .getByRole("searchbox", { name: "Search published pages", exact: true })
      .fill("Standards");
    await expect(
      nav.getByRole("link", { name: "Standards", exact: true }),
    ).toBeVisible();
    assert.equal(requests.length, before);
    await nav.getByRole("link", { name: "Standards", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Standards", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Published breadcrumbs", exact: true })
        .getByRole("link", { name: "Design", exact: true }),
    ).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/publication-hierarchy.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const picker = nav.locator("details");
    await expect(picker).not.toHaveAttribute("open");
    await nav.locator("summary").click();
    await expect(
      nav.getByRole("link", { name: "Design", exact: true }),
    ).toBeVisible();
    await nav
      .getByRole("searchbox", { name: "Search published pages", exact: true })
      .fill("Guide 05");
    await expect(
      nav.getByRole("link", { name: "Guide 05", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/ui-review/publication-page-picker.png",
      fullPage: true,
    });
    await nav
      .getByRole("searchbox", { name: "Search published pages", exact: true })
      .press("Escape");
    await expect(picker).not.toHaveAttribute("open");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("Chromium: lost publication responses retain the reviewed request through automatic and manual retries", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs");
  let browser;
  try {
    const f = await fixture();
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 950 },
    });
    await context.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    const page = await context.newPage();
    const ids = [];
    let losses = 2;
    await page.route("**/api/v1/" + f.path, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      ids.push(route.request().postDataJSON().requestId);
      const result = await route.fetch();
      assert.equal(result.status(), 201);
      if (losses-- > 0) {
        return route.abort("connectionreset");
      }
      return route.fulfill({ response: result });
    });
    await page.goto(base + "/?page=" + f.root.id);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.root.title);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await review
      .getByRole("button", { name: "Publish snapshot", exact: true })
      .click();
    await expect(review.getByRole("alert")).toContainText(
      "Could not confirm the publication",
    );
    assert.equal(ids.length, 2);
    await review
      .getByRole("button", { name: "Retry publication", exact: true })
      .click();
    await expect(
      share.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    assert.equal(ids.length, 3);
    assert.equal(ids[0], ids[2]);
    assert.equal(ids[0], ids[1]);
    assert.equal((await request(f.path, { cookie: f.cookie })).data.length, 1);
  } finally {
    await browser?.close();
  }
});
