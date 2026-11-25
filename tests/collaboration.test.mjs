import { peer, waitFor } from "./collaboration-peer.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, connect as tcpConnect } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import * as Y from "yjs";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { yDocToDocument } from "../packages/editor/dist/index.js";
const text = (doc) => {
  const visit = (n) => n.text || (n.content || []).map(visit).join("");
  return visit(yDocToDocument(doc));
};

function append(doc, value) {
  doc.transact(() => {
    const paragraph = doc.getXmlFragment("default").get(0);
    let node = paragraph.get(0);
    if (!node) {
      node = new Y.XmlText();
      paragraph.insert(0, [node]);
    }
    node.insert(node.length, value);
  });
}

test("Yjs: concurrent replicas, durable acknowledgement, reconnect, read-only and active revocation", async () => {
  const urls = JSON.parse(process.env.COLLABORATION_TEST_URLS),
    db = new Pool({ connectionString: process.env.DATABASE_URL }),
    peers = [];
  let recovery,
    proxy,
    recoveryOutput = "";
  const sockets = new Set();
  const account = async () => {
    const email = randomUUID() + "@example.test";
    const r = await request("auth/register", {
      method: "POST",
      body: { email, password: randomUUID() },
    });
    assert.equal(r.response.status, 201);
    const cookie = sessionCookie(r.response),
      me = (await request("auth/me", { cookie })).data;
    return { cookie, ...me };
  };
  try {
    const owner = await account(),
      editor = await account(),
      viewer = await account();
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Live collaboration" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query(
      "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer')",
      [space.id, editor.id, viewer.id],
    );
    const page = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Shared Yjs document" },
      })
    ).data;
    const connect = (...args) => {
      const p = peer(...args);
      peers.push(p);
      return p;
    };
    const absent = connect(urls[0], page.id);
    await waitFor(
      () => absent.rejected || absent.closed,
      "Unauthenticated WebSocket must be rejected",
    );
    assert.match(absent.reason, /Document access denied/);
    absent.destroy();
    peers.splice(peers.indexOf(absent), 1);
    const hostile = connect(
      urls[0],
      page.id,
      owner.cookie,
      "https://evil.example",
    );
    await waitFor(
      () => hostile.rejected || hostile.closed,
      "Cross-origin WebSocket must be rejected",
    );
    assert.match(hostile.reason, /Document access denied/);
    hostile.destroy();
    peers.splice(peers.indexOf(hostile), 1);
    const a = connect(urls[0], page.id, owner.cookie),
      b = connect(urls[1], page.id, editor.cookie),
      v = connect(urls[1], page.id, viewer.cookie);
    await waitFor(
      () => a.provider.isSynced && b.provider.isSynced && v.provider.isSynced,
      "All peers must synchronize",
    );
    assert.equal(v.provider.authorizedScope, "readonly");
    append(a.doc, "Seed.");
    await waitFor(
      () => text(b.doc) === "Seed." && text(v.doc) === "Seed.",
      "Seed must cross replica boundary",
    );
    append(a.doc, " Owner.");
    append(b.doc, " Editor.");
    await waitFor(
      () =>
        text(a.doc) === text(b.doc) &&
        text(a.doc).includes("Owner.") &&
        text(a.doc).includes("Editor."),
      "Concurrent edits must converge",
    );
    await waitFor(
      () => !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges,
      "Durable changes must be acknowledged",
    );
    const projection = (
      await request("pages/" + page.id, { cookie: owner.cookie })
    ).data;
    assert.ok(JSON.stringify(projection.document).includes("Owner."));
    assert.ok(JSON.stringify(projection.document).includes("Editor."));
    append(v.doc, " VIEWER_ATTACK");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      JSON.stringify(
        (await request("pages/" + page.id, { cookie: owner.cookie })).data
          .document,
      ).includes("VIEWER_ATTACK"),
      false,
    );
    v.provider.awareness.setLocalStateField("user", {
      id: owner.id,
      name: "Forged owner",
      color: "url(https://evil.example)",
    });
    await waitFor(
      () =>
        a.provider.awareness.getStates().get(v.doc.clientID)?.user?.id ===
        viewer.id,
      "Presence identity must be authenticated",
    );
    assert.equal(
      a.provider.awareness.getStates().get(v.doc.clientID).user.name,
      viewer.displayName,
    );
    b.socket.disconnect();
    await waitFor(() => b.closed, "Disconnect should be observable");
    append(b.doc, " Offline.");
    assert.equal(
      JSON.stringify(
        (await request("pages/" + page.id, { cookie: owner.cookie })).data
          .document,
      ).includes("Offline."),
      false,
    );
    void b.socket.connect();
    await waitFor(
      () =>
        b.provider.isSynced &&
        !b.provider.hasUnsyncedChanges &&
        text(a.doc).includes("Offline."),
      "Reconnect must persist queued changes",
    );
    await request(`spaces/${space.id}/members/${editor.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    await waitFor(
      () => !b.provider.isAuthenticated && !b.provider.isSynced,
      "Revocation must close an existing document connection",
    );
    append(a.doc, " After revocation.");
    await waitFor(
      () => !a.provider.hasUnsyncedChanges,
      "Post-revocation edit must persist",
    );
    assert.equal(text(b.doc).includes("After revocation."), false);
    const savedText = text(a.doc);
    const apiOverwrite = await request("pages/" + page.id, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        title: page.title,
        version: projection.version,
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Overwrite" }],
            },
          ],
        },
      },
    });
    assert.equal(apiOverwrite.response.status, 409);
    // Start a process with an independent Redis namespace: its source can only be PostgreSQL.
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const recoveryPort = portServer.address().port;
    await new Promise((r) => portServer.close(r));
    const redisUrl = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379");
    proxy = createServer((incoming) => {
      const outgoing = tcpConnect({
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
      });
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {
          incoming.destroy();
          outgoing.destroy();
        });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyUrl = new URL(redisUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(proxy.address().port);
    recovery = spawn(process.execPath, ["apps/collaboration/dist/main.js"], {
      env: {
        ...process.env,
        COLLABORATION_PORT: String(recoveryPort),
        REDIS_URL: proxyUrl.toString(),
        COLLABORATION_NAMESPACE: "recovery-" + randomUUID(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    recovery.stderr.on("data", (b) => {
      recoveryOutput = (recoveryOutput + b.toString()).slice(-8000);
    });
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${recoveryPort}/health`)).ok;
      } catch {
        return false;
      }
    }, "Recovery service must start");
    const restored = connect(
      "ws://127.0.0.1:" + recoveryPort,
      page.id,
      owner.cookie,
    );
    await waitFor(
      () => restored.provider.isSynced,
      "Independent service must load stored CRDT",
    );
    assert.equal(text(restored.doc), savedText);
    const exited = once(recovery, "exit");
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => proxy.close(r));
    proxy = null;
    const [exitCode] = await exited;
    assert.equal(
      exitCode,
      1,
      "Losing Redis must fail closed and require process restart",
    );
    assert.ok(
      recoveryOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .some(
          (event) =>
            event.event === "coordination.lost" &&
            event.code === "VALKEY_COORDINATION_LOST",
        ),
      "Coordination failure must produce a structured, actionable diagnostic",
    );
    await waitFor(
      () => !restored.provider.isAuthenticated,
      "Coordination loss must disconnect editors",
    );
  } finally {
    for (const peer of peers) peer.destroy();
    if (recovery && recovery.exitCode === null) {
      recovery.kill("SIGTERM");
      await once(recovery, "exit");
    }
    if (proxy) {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => proxy.close(r));
    }
    await db.end();
  }
});
