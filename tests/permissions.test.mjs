import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  request,
  sessionCookie,
  waitForMail,
  emailToken,
  Pool,
} from "./helpers.mjs";
test("team conversion, verified invitations, inherited roles, safe moves, trash and revocation", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const call = async (path, method, cookie, body) =>
    request(path, { method, cookie, body });
  const account = async () => {
    const email = randomUUID() + "@example.test",
      r = await call("auth/register", "POST", undefined, {
        email,
        password: randomUUID(),
      });
    assert.equal(r.response.status, 201);
    await db.query("UPDATE users SET email_verified=true WHERE email=$1", [
      email,
    ]);
    const cookie = sessionCookie(r.response),
      me = (await request("auth/me", { cookie })).data;
    return { email, cookie, id: me.id };
  };
  try {
    const owner = await account(),
      editor = await account(),
      viewer = await account(),
      outsider = await account();
    const space = (
      await call("spaces", "POST", owner.cookie, { name: "Permission test" })
    ).data;
    const create = async (cookie, title, parentId = null) => {
      const r = await call(`spaces/${space.id}/pages`, "POST", cookie, {
        title,
        parentId,
      });
      assert.equal(r.response.status, 201, JSON.stringify(r.data));
      return r.data;
    };
    const privateRoot = await create(owner.cookie, "Private before conversion");
    const secret = await create(owner.cookie, "Secret child", privateRoot.id);
    const oldPreview = (
      await request(`spaces/${space.id}/team-preview`, { cookie: owner.cookie })
    ).data;
    await create(owner.cookie, "Another private root");
    assert.equal(
      (
        await call(`spaces/${space.id}/convert-to-team`, "POST", owner.cookie, {
          confirm: true,
          version: oldPreview.version,
        })
      ).response.status,
      409,
    );
    const preview = (
      await request(`spaces/${space.id}/team-preview`, { cookie: owner.cookie })
    ).data;
    assert.equal(
      (
        await call(`spaces/${space.id}/convert-to-team`, "POST", owner.cookie, {
          confirm: true,
          version: preview.version,
        })
      ).response.status,
      201,
    );
    async function invite(member, role) {
      const r = await call(
        `spaces/${space.id}/invitations`,
        "POST",
        owner.cookie,
        { email: member.email, role },
      );
      assert.equal(r.response.status, 201, JSON.stringify(r.data));
      const token = emailToken(
        await waitForMail(member.email, "Orvyn space invitation"),
      );
      assert.equal(
        (
          await call("spaces/invitations/accept", "POST", outsider.cookie, {
            token,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await call("spaces/invitations/accept", "POST", member.cookie, {
            token,
          })
        ).response.status,
        201,
      );
      assert.equal(
        (
          await call("spaces/invitations/accept", "POST", member.cookie, {
            token,
          })
        ).response.status,
        400,
      );
    }
    await invite(editor, "Editor");
    await invite(viewer, "Viewer");
    assert.equal(
      (await request("spaces", { cookie: editor.cookie })).data.find(
        (s) => s.id === space.id,
      ).role,
      "Editor",
    );
    assert.deepEqual(
      (await request(`spaces/${space.id}/pages`, { cookie: editor.cookie }))
        .data,
      [],
    );
    assert.equal(
      (await request("pages/" + secret.id, { cookie: editor.cookie })).response
        .status,
      404,
    );
    const shared = await create(editor.cookie, "Shared root");
    const child = await create(editor.cookie, "Shared child", shared.id);
    assert.equal(
      (await request("pages/" + shared.id, { cookie: viewer.cookie })).response
        .status,
      200,
    );
    assert.equal(
      (
        await call(`spaces/${space.id}/pages`, "POST", viewer.cookie, {
          title: "Forbidden",
        })
      ).response.status,
      404,
    );
    const input = {
      title: "Saved by editor",
      version: shared.version,
      document: {
        type: "doc",
        content: [{ type: "paragraph", text: "Team content" }],
      },
    };
    assert.equal(
      (await call("pages/" + shared.id, "PUT", viewer.cookie, input)).response
        .status,
      404,
    );
    assert.equal(
      (await call("pages/" + shared.id, "PUT", editor.cookie, input)).response
        .status,
      200,
    );
    const history = (
      await request("pages/" + shared.id + "/history", {
        cookie: viewer.cookie,
      })
    ).data;
    assert.equal(history.length, 2);
    assert.equal(
      (
        await request("pages/" + shared.id + "/history/1", {
          cookie: outsider.cookie,
        })
      ).response.status,
      404,
    );
    async function restrict(id, grants) {
      const p = (await request("pages/" + id, { cookie: owner.cookie })).data;
      return call("pages/" + id + "/permissions", "PUT", owner.cookie, {
        visibility: "restricted",
        confirm: true,
        version: p.version,
        grants,
      });
    }
    assert.equal(
      (await restrict(shared.id, [{ userId: editor.id, role: "Viewer" }]))
        .response.status,
      200,
    );
    assert.equal(
      (await restrict(child.id, [{ userId: editor.id, role: "Editor" }]))
        .response.status,
      200,
    );
    const effective = (
      await request("pages/" + child.id, { cookie: editor.cookie })
    ).data;
    assert.equal(effective.access_rank, 10);
    assert.equal(
      (
        await call("pages/" + child.id, "PUT", editor.cookie, {
          ...input,
          version: effective.version,
        })
      ).response.status,
      404,
    );
    assert.equal(
      (await request("pages/" + child.id, { cookie: viewer.cookie })).response
        .status,
      404,
    );
    await restrict(shared.id, [
      { userId: editor.id, role: "Editor" },
      { userId: viewer.id, role: "Viewer" },
    ]);
    await restrict(child.id, []);
    assert.equal(
      (
        await call("pages/" + shared.id, "DELETE", editor.cookie, {
          confirm: true,
        })
      ).response.status,
      403,
    );
    let current = (
      await request("pages/" + shared.id, { cookie: owner.cookie })
    ).data;
    assert.equal(
      (
        await call("pages/" + shared.id + "/move", "POST", owner.cookie, {
          version: current.version,
          parentId: child.id,
          sortOrder: 0,
        })
      ).response.status,
      400,
    );
    let confidential = (
      await request("pages/" + secret.id, { cookie: owner.cookie })
    ).data;
    assert.equal(
      (
        await call("pages/" + secret.id + "/move", "POST", owner.cookie, {
          version: confidential.version,
          parentId: shared.id,
          sortOrder: 0,
        })
      ).response.status,
      201,
    );
    assert.equal(
      (await request("pages/" + secret.id, { cookie: editor.cookie })).response
        .status,
      404,
    );
    assert.deepEqual(
      (
        await request(`spaces/${space.id}/pages?q=Secret`, {
          cookie: editor.cookie,
        })
      ).data,
      [],
    );
    assert.equal(
      (
        await call("pages/" + shared.id, "DELETE", owner.cookie, {
          confirm: true,
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await request("pages/" + shared.id, { cookie: owner.cookie })).response
        .status,
      404,
    );
    assert.equal(
      (
        await request(`spaces/${space.id}/trash`, { cookie: owner.cookie })
      ).data.some((p) => p.id === shared.id),
      true,
    );
    assert.equal(
      (await call("pages/" + shared.id + "/restore", "POST", owner.cookie, {}))
        .response.status,
      201,
    );
    assert.equal(
      (await request("pages/" + shared.id, { cookie: editor.cookie })).response
        .status,
      200,
    );
    assert.equal(
      (
        await call(
          `spaces/${space.id}/members/${editor.id}`,
          "DELETE",
          owner.cookie,
          {},
        )
      ).response.status,
      200,
    );
    assert.equal(
      (await request("spaces", { cookie: editor.cookie })).data.some(
        (s) => s.id === space.id,
      ),
      false,
    );
    for (const suffix of ["", "/history", "/history/1", "/permissions"])
      assert.equal(
        (
          await request("pages/" + shared.id + suffix, {
            cookie: editor.cookie,
          })
        ).response.status,
        404,
      );
  } finally {
    await db.end();
  }
});
