import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { attachments } from "../apps/api/dist/files/storage.js";
test(`private ${attachments().driver} attachments enforce page access, inline MIME policy, upload limits and cleanup`, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    store = attachments();
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    assert.equal(r.response.status, 201);
    const cookie = sessionCookie(r.response),
      me = (await request("auth/me", { cookie })).data;
    return { ...me, cookie };
  };
  async function upload(
    page,
    cookie,
    bytes,
    name,
    type = "text/html",
    origin = process.env.TEST_ORIGIN,
  ) {
    const body = new FormData();
    body.append("file", new Blob([bytes], { type }), name);
    const response = await fetch(base + "/api/v1/pages/" + page.id + "/files", {
      method: "POST",
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      body,
    });
    return { response, data: await response.json() };
  }
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account();
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Attachments" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const page = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Private objects" },
      })
    ).data;
    assert.equal(
      (await upload(page, undefined, "unauth", "x.txt")).response.status,
      401,
    );
    assert.equal(
      (await upload(page, viewer.cookie, "readonly", "x.txt")).response.status,
      404,
    );
    assert.equal(
      (
        await upload(
          page,
          owner.cookie,
          "csrf",
          "x.txt",
          "text/plain",
          "https://evil.example",
        )
      ).response.status,
      403,
    );
    const content = "<script>not executable</script>",
      file = await upload(page, owner.cookie, content, "prüfung.html");
    assert.equal(file.response.status, 201, JSON.stringify(file.data));
    assert.equal(file.data.media_type, "application/octet-stream");
    assert.equal(file.data.filename, "prüfung.html");
    assert.equal(JSON.stringify(file.data).includes("object_key"), false);
    const direct = await db.query("SELECT object_key FROM files WHERE id=$1", [
      file.data.id,
    ]);
    assert.equal(await store.exists(direct.rows[0].object_key), true);
    if (store.driver === "s3") {
      const anonymous = new URL(process.env.S3_ENDPOINT);
      anonymous.pathname =
        "/" + process.env.S3_BUCKET + "/" + direct.rows[0].object_key;
      assert.equal((await fetch(anonymous)).status, 403);
    }
    let response = await fetch(
      base + "/api/v1/files/" + file.data.id + "/download",
      { headers: { Cookie: viewer.cookie } },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(response.headers.get("content-disposition"), /^attachment/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      (
        await fetch(base + "/api/v1/files/" + file.data.id + "/preview", {
          headers: { Cookie: owner.cookie },
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await request("pages/" + page.id + "/files", {
          cookie: outsider.cookie,
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/v1/files/" + file.data.id + "/download", {
          headers: { Cookie: outsider.cookie },
        })
      ).status,
      404,
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JHcAAAAASUVORK5CYII=",
      "base64",
    );
    const image = await upload(
      page,
      owner.cookie,
      png,
      "preview.png",
      "text/html",
    );
    assert.equal(image.response.status, 201);
    assert.equal(image.data.media_type, "image/png");
    const preview = await fetch(
      base + "/api/v1/files/" + image.data.id + "/preview",
      { headers: { Cookie: viewer.cookie } },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
    await request("pages/" + page.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: true },
    });
    assert.equal(
      (
        await fetch(base + "/api/v1/files/" + image.data.id + "/download", {
          headers: { Cookie: owner.cookie },
        })
      ).status,
      404,
    );
    await request("pages/" + page.id + "/restore", {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    assert.equal(
      (
        await fetch(base + "/api/v1/files/" + image.data.id + "/download", {
          headers: { Cookie: owner.cookie },
        })
      ).status,
      200,
    );
    const oversized = await upload(
      page,
      owner.cookie,
      Buffer.alloc(10 * 1024 * 1024 + 1),
      "large.bin",
      "application/octet-stream",
    );
    assert.equal(oversized.response.status, 413);
    assert.equal(
      (
        await request("files/" + file.data.id, {
          method: "DELETE",
          cookie: viewer.cookie,
          body: {},
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request("files/" + file.data.id, {
          method: "DELETE",
          cookie: owner.cookie,
          body: {},
        })
      ).response.status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/v1/files/" + file.data.id + "/download", {
          headers: { Cookie: owner.cookie },
        })
      ).status,
      404,
    );
    await db.query(
      "UPDATE files SET deleted_at=now()-interval '31 days' WHERE id=$1",
      [file.data.id],
    );
    const end = Date.now() + 12000;
    while (
      Date.now() < end &&
      (await db.query("SELECT id FROM files WHERE id=$1", [file.data.id]))
        .rowCount
    )
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      (await db.query("SELECT id FROM files WHERE id=$1", [file.data.id]))
        .rowCount,
      0,
    );
    assert.equal(await store.exists(direct.rows[0].object_key), false);
    await request(`spaces/${space.id}/members/${viewer.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    assert.equal(
      (
        await fetch(base + "/api/v1/files/" + image.data.id + "/download", {
          headers: { Cookie: viewer.cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (await request("pages/" + page.id + "/files", { cookie: viewer.cookie }))
        .response.status,
      404,
    );
    const key = "orphan-test/" + randomUUID();
    await store.put(key, { body: Buffer.from("orphan"), size: 6 });
    assert.equal(await store.exists(key), true);
    const orphan = (
      await db.query(
        "INSERT INTO files(page_id,object_key,filename,media_type,size,uploaded_by,created_at) VALUES($1,$2,'orphan','application/octet-stream',6,$3,now()-interval '2 hours') RETURNING id",
        [page.id, key, owner.id],
      )
    ).rows[0].id;
    const deadline = Date.now() + 12000;
    while (
      Date.now() < deadline &&
      (await db.query("SELECT id FROM files WHERE id=$1", [orphan])).rowCount
    )
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      (await db.query("SELECT id FROM files WHERE id=$1", [orphan])).rowCount,
      0,
    );
    assert.equal(await store.exists(key), false);
  } finally {
    store.close();
    await db.end();
  }
});
