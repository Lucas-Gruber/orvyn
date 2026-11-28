import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { base, Pool, request, sessionCookie } from "./helpers.mjs";

async function account() {
  const registered = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  assert.equal(registered.response.status, 201);
  const cookie = sessionCookie(registered.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}

async function fixture(db) {
  const owner = await account(),
    member = await account(),
    stranger = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Agent knowledge" },
    })
  ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    member.id,
  ]);
  async function page(title, parentId) {
    const result = await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title, parentId },
    });
    assert.equal(result.response.status, 201);
    return result.data;
  }
  const source = await page("Shared instructions"),
    child = await page("Child is not granted", source.id);
  const hidden = await page("PRIVATE unrelated title");
  await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
    hidden.id,
  ]);
  const document = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Orvyn is authoritative. Read the current saved page.",
          },
        ],
      },
      {
        type: "orvynPagePreview",
        attrs: { pageId: hidden.id, headingId: null },
      },
    ],
  };
  await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
    source.id,
    document,
  ]);
  const tokenBody = {
    label: "Synthetic reader",
    spaceId: space.id,
    pageIds: [source.id],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    confirm: true,
  };
  const mint = (body = tokenBody, cookie = member.cookie) =>
    request("integrations/tokens", {
      method: "POST",
      cookie,
      body,
    });
  return {
    owner,
    member,
    stranger,
    space,
    source,
    child,
    hidden,
    tokenBody,
    mint,
  };
}

async function machine(
  path,
  token,
  { method = "GET", body, headers = {} } = {},
) {
  const response = await fetch(base + "/api/v1/" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test("scoped machine access reads canonical pages without widening cookie or linked-resource access", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      minted = await f.mint();
    assert.equal(minted.response.status, 201, JSON.stringify(minted.data));
    const { token, id } = minted.data;
    assert.match(token, /^orvyn_agent_[a-f0-9]{64}$/);
    const stored = (
      await db.query(
        "SELECT token_hash,scope FROM integration_tokens WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(
      stored.token_hash,
      createHash("sha256").update(token).digest("hex"),
    );
    assert.equal(stored.scope, "pages:read");
    const read = await machine(`integrations/pages/${f.source.id}`, token);
    assert.equal(read.response.status, 200, JSON.stringify(read.data));
    assert.equal(read.response.headers.get("cache-control"), "no-store");
    assert.equal(read.data.source, "orvyn");
    assert.equal(read.data.page.id, f.source.id);
    assert.match(read.data.markdown, /Orvyn is authoritative/);
    assert.doesNotMatch(JSON.stringify(read.data), /PRIVATE unrelated title/);
    assert.equal(read.data.page.access_rank, undefined);
    assert.equal(read.data.page.created_by, undefined);
    assert.ok(
      read.data.warnings.some((w) => /without copying their content/.test(w)),
    );
    for (const denied of [f.child.id, f.hidden.id, randomUUID()]) {
      assert.equal(
        (await machine(`integrations/pages/${denied}`, token)).response.status,
        404,
      );
    }
    assert.equal(
      (await machine(`pages/${f.source.id}`, token)).response.status,
      401,
    );
    assert.equal(
      (await machine("integrations/tokens", token)).response.status,
      401,
    );
    assert.equal(
      (
        await machine(`pages/${f.source.id}`, token, {
          method: "PUT",
          headers: {
            Origin: process.env.TEST_ORIGIN,
            "Content-Type": "application/json",
          },
          body: {
            title: "Attempt",
            document: read.data.page.document,
            version: read.data.page.version,
          },
        })
      ).response.status,
      401,
    );
    assert.equal(
      (
        await request(`integrations/pages/${f.source.id}`, {
          cookie: f.member.cookie,
        })
      ).response.status,
      401,
    );
    assert.equal(
      (await machine(`integrations/pages/${f.source.id}?token=${token}`))
        .response.status,
      401,
    );
    const listed = await request("integrations/tokens", {
      cookie: f.member.cookie,
    });
    assert.ok(listed.data.some((t) => t.id === id));
    assert.doesNotMatch(JSON.stringify(listed.data), /token_hash|orvyn_agent_/);
    assert.deepEqual(
      (await request("integrations/tokens", { cookie: f.stranger.cookie }))
        .data,
      [],
    );
    await db.query(
      "UPDATE pages SET title='Updated in Orvyn',version=version+1 WHERE id=$1",
      [f.source.id],
    );
    const latest = await machine(`integrations/pages/${f.source.id}`, token);
    assert.equal(latest.data.page.title, "Updated in Orvyn");
    assert.equal(latest.data.page.version, read.data.page.version + 1);
    const large = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a".repeat(1024 * 1024 + 1) }],
        },
      ],
    };
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.source.id,
      large,
    ]);
    const structured = await machine(
      `integrations/pages/${f.source.id}`,
      token,
    );
    assert.equal(structured.response.status, 200);
    assert.equal(structured.data.markdown, null);
    assert.equal(
      structured.data.page.document.content[0].content[0].text.length,
      1024 * 1024 + 1,
    );
    assert.match(structured.data.warnings[0], /structured document/);
  } finally {
    await db.end();
  }
});

test("expiry, explicit revocation, current restrictions, membership and trash stop machine reads", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      minted = await f.mint(),
      { token, id } = minted.data;
    const read = () => machine(`integrations/pages/${f.source.id}`, token);
    const childToken = (await f.mint({ ...f.tokenBody, pageIds: [f.child.id] }))
      .data.token;
    assert.equal((await read()).response.status, 200);
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.source.id,
    ]);
    assert.equal((await read()).response.status, 404);
    assert.equal(
      (await machine(`integrations/pages/${f.child.id}`, childToken)).response
        .status,
      404,
    );
    await db.query("UPDATE pages SET visibility='space' WHERE id=$1", [
      f.source.id,
    ]);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.member.id],
    );
    assert.equal((await read()).response.status, 404);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.space.id,
      f.member.id,
    ]);
    await db.query("UPDATE pages SET deleted_at=now() WHERE id=$1", [
      f.source.id,
    ]);
    assert.equal((await read()).response.status, 404);
    await db.query("UPDATE pages SET deleted_at=NULL WHERE id=$1", [
      f.source.id,
    ]);
    assert.equal((await read()).response.status, 200);
    assert.equal(
      (
        await request(`integrations/tokens/${id}`, {
          method: "DELETE",
          cookie: f.stranger.cookie,
          body: {},
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request(`integrations/tokens/${id}`, {
          method: "DELETE",
          cookie: f.member.cookie,
          body: {},
        })
      ).response.status,
      200,
    );
    assert.equal((await read()).response.status, 404);
    const expiring = await f.mint();
    await db.query(
      "UPDATE integration_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [expiring.data.id],
    );
    assert.equal(
      (await machine(`integrations/pages/${f.source.id}`, expiring.data.token))
        .response.status,
      404,
    );
    const audits = (
      await db.query("SELECT event FROM audit_events WHERE actor_id=$1", [
        f.member.id,
      ])
    ).rows.map((r) => r.event);
    assert.ok(audits.includes("integration.token_created"));
    assert.ok(audits.includes("integration.token_revoked"));
  } finally {
    await db.end();
  }
});

test("credential creation requires an explicit bounded authorized scope and preserves collaboration protection", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    for (const patch of [
      { pageIds: [] },
      { pageIds: [f.source.id, f.source.id] },
      { pageIds: Array.from({ length: 101 }, () => randomUUID()) },
      { confirm: false },
      { scope: "pages:write" },
      { expiresAt: new Date(Date.now() - 60000).toISOString() },
      { expiresAt: new Date(Date.now() + 31 * 86400000).toISOString() },
    ])
      assert.equal(
        (await f.mint({ ...f.tokenBody, ...patch })).response.status,
        400,
      );
    assert.equal(
      (await f.mint({ ...f.tokenBody, pageIds: [f.hidden.id] })).response
        .status,
      404,
    );
    assert.equal(
      (await f.mint(f.tokenBody, f.stranger.cookie)).response.status,
      404,
    );
    assert.equal(
      (
        await request("integrations/tokens", {
          method: "POST",
          cookie: f.member.cookie,
          body: f.tokenBody,
          origin: "https://untrusted.example",
        })
      ).response.status,
      403,
    );
    const manyPages = (
      await db.query(
        "INSERT INTO pages(space_id,title,created_by,last_edited_by) SELECT $1,'Explicit doc '||i,$2,$2 FROM generate_series(1,100) AS i RETURNING id",
        [f.space.id, f.owner.id],
      )
    ).rows.map((p) => p.id);
    const hundred = await f.mint({ ...f.tokenBody, pageIds: manyPages });
    assert.equal(hundred.response.status, 201);
    assert.equal(hundred.data.pageIds.length, 100);
    for (const id of [manyPages[0], manyPages.at(-1)])
      assert.equal(
        (await machine(`integrations/pages/${id}`, hundred.data.token)).response
          .status,
        200,
      );
    assert.equal(
      (await machine(`integrations/pages/${f.source.id}`, hundred.data.token))
        .response.status,
      404,
    );
    await db.query(
      "INSERT INTO editor_documents(page_id,state) VALUES($1,$2)",
      [f.source.id, Buffer.from([0, 0])],
    );
    const unchanged = await request(`pages/${f.source.id}`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        version: 1,
        title: "Rejected replacement",
        document: { type: "doc", content: [{ type: "paragraph" }] },
      },
    });
    assert.equal(unchanged.response.status, 409);
    assert.match(unchanged.data.message, /collaboration connection/);
    const token = (await f.mint()).data.token;
    assert.equal(
      (await machine(`integrations/pages/${f.source.id}`, token)).response
        .status,
      200,
    );
    assert.equal(
      (await db.query("SELECT title FROM pages WHERE id=$1", [f.source.id]))
        .rows[0].title,
      "Shared instructions",
    );
  } finally {
    await db.end();
  }
});
