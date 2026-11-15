import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WS from "ws";
import * as Y from "yjs";
import { yDocToDocument } from "../packages/editor/dist/index.js";
import { request, sessionCookie, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
test("single-port preview tunnels authenticated collaboration and preserves origin and session revocation", async () => {
  const result = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(result.response);
  const space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Forwarded preview" },
      })
    ).data,
    page = (
      await request("spaces/" + space.id + "/pages", {
        method: "POST",
        cookie,
        body: { title: "Same-port collaboration" },
      })
    ).data;
  const url = base.replace(/^http/, "ws") + "/collaboration";
  async function status(headers) {
    return new Promise((resolve, reject) => {
      const ws = new WS(url, { headers, handshakeTimeout: 3000 });
      ws.on("error", () => {});
      ws.once("unexpected-response", (_, response) => {
        response.resume();
        resolve(response.statusCode);
        ws.terminate();
      });
      ws.once("open", () => {
        ws.close();
        reject(Error("Unauthorized upgrade succeeded"));
      });
    });
  }
  assert.equal(await status({ Origin: process.env.TEST_ORIGIN }), 401);
  assert.equal(
    await status({
      Origin: "https://untrusted.example.test",
      Cookie: cookie,
      "X-Forwarded-Host": new URL(base).host,
      "X-Forwarded-Proto": "http",
    }),
    403,
  );
  const first = peer(url, page.id, cookie),
    second = peer(url, page.id, cookie);
  try {
    await waitFor(
      () => first.provider.isSynced && second.provider.isSynced,
      "both clients must synchronize through the web port",
    );
    first.doc.transact(() => {
      const paragraph = first.doc.getXmlFragment("default").get(0),
        text = new Y.XmlText();
      paragraph.insert(0, [text]);
      text.insert(0, "A real update through the forwarded web port");
    });
    await waitFor(
      () =>
        JSON.stringify(yDocToDocument(second.doc)).includes(
          "A real update through the forwarded web port",
        ),
      "the tunnel must relay binary editor updates",
    );
    assert.ok(
      JSON.stringify(
        (await request("pages/" + page.id, { cookie })).data.document,
      ).includes("A real update through the forwarded web port"),
    );
    assert.equal(
      (await request("auth/logout", { method: "POST", cookie, body: {} }))
        .response.status,
      201,
    );
    await waitFor(
      () => first.closed && second.closed,
      "revoked sessions must close both proxied connections",
    );
  } finally {
    first.destroy();
    second.destroy();
  }
});
