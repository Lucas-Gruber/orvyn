import {
  Server,
  IncomingMessage,
  MessageType,
  type Connection,
} from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Redis as RedisClient } from "ioredis";
import { Pool, type PoolClient } from "pg";
import { authenticateCookie } from "@orvyn/auth";
import { documentToYDoc, yDocToDocument } from "@orvyn/editor";
import * as Y from "yjs";
import { createHash } from "node:crypto";

type Identity = {
  userId: string;
  email: string;
  sessionHash: string;
  spaceId: string;
};
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const live = new Set<Connection<Identity>>();
let stopping = false,
  poisoned = false,
  revalidating = false;
const origin = process.env.ORVYN_ORIGIN || "http://localhost:3000";
const redis = new RedisClient(
  process.env.REDIS_URL || "redis://127.0.0.1:6379",
  { connectTimeout: 2000, maxRetriesPerRequest: 1 },
);
redis.on("error", () => {});
const extension = new RedisExtension({
  redis,
  prefix: process.env.COLLABORATION_NAMESPACE || "orvyn:collaboration",
  lockTimeout: 0,
  disconnectDelay: 50,
});
function ready() {
  return (
    !stopping &&
    !poisoned &&
    extension.pub?.status === "ready" &&
    extension.sub?.status === "ready"
  );
}
function deny(): never {
  throw { code: 4403, reason: "Document access denied" };
}
async function transaction<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function authorization(
  c: Pool | PoolClient,
  identity: Identity,
  pageId: string,
  lock = false,
) {
  const session = await c.query(
    `SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now() ${lock ? "FOR SHARE" : ""}`,
    [identity.sessionHash],
  );
  if (!session.rowCount || session.rows[0].user_id !== identity.userId) deny();
  if (lock)
    await c.query(
      "SELECT s.id FROM spaces s JOIN pages p ON p.space_id=s.id WHERE p.id=$1 FOR SHARE OF s",
      [pageId],
    );
  const r = await c.query(
    "SELECT orvyn_page_role(id,$2) AS rank FROM pages WHERE id=$1",
    [pageId, identity.userId],
  );
  const rank = r.rows[0]?.rank || 0;
  if (rank < 10) deny();
  return rank as number;
}
// Hocuspocus exposes synchronous sends. Queue each outbound frame behind the
// same database authorization locks used by revocation, including initial presence.
function guardOutbound(connection: Connection<Identity>) {
  const send = connection.send.bind(connection);
  let pending = Promise.resolve(),
    closed = false,
    count = 0,
    bytes = 0;
  connection.onClose(() => {
    closed = true;
  });
  connection.send = (message: Uint8Array) => {
    const decoded = new IncomingMessage(message);
    decoded.readVarString();
    if (decoded.readVarUint() === MessageType.CLOSE) {
      closed = true;
      send(message);
      return;
    }
    if (closed) return;
    if (count >= 32 || bytes + message.byteLength > 4 * 1024 * 1024) {
      connection.close({ code: 1013, reason: "Outbound queue limit" });
      return;
    }
    count++;
    bytes += message.byteLength;
    pending = pending
      .then(async () => {
        if (closed) return;
        await transaction(async (c) => {
          if (!ready()) deny();
          await authorization(
            c,
            connection.context,
            connection.document.name,
            true,
          );
          if (!closed) send(message);
        });
      })
      .catch(() => {
        connection.close({ code: 4403, reason: "Access changed" });
      })
      .finally(() => {
        count--;
        bytes -= message.byteLength;
      });
  };
}
async function revalidate() {
  if (revalidating) return;
  revalidating = true;
  try {
    await Promise.allSettled(
      [...live].map(async (connection) => {
        try {
          if (!ready()) deny();
          const rank = await authorization(
            db,
            connection.context,
            connection.document.name,
          );
          const readOnly = rank < 30;
          if (readOnly !== connection.readOnly) {
            connection.readOnly = readOnly;
            connection.sendStateless(
              JSON.stringify({ type: "permissions", readOnly }),
            );
          }
        } catch {
          connection.close({ code: 4403, reason: "Access changed" });
        }
      }),
    );
  } finally {
    revalidating = false;
  }
}
const server = new Server<Identity>({
  port: Number(process.env.COLLABORATION_PORT || 3002),
  address: "0.0.0.0",
  quiet: true,
  stopOnSignals: false,
  websocketOptions: { maxPayload: 2 * 1024 * 1024 },
  extensions: [extension],
  async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
    if (
      !ready() ||
      requestHeaders.get("origin") !== origin ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        documentName,
      )
    )
      deny();
    const identity = await authenticateCookie(
      db,
      requestHeaders.get("cookie") || "",
    );
    if (!identity) deny();
    const p = await db.query(
      "SELECT space_id,orvyn_page_role(id,$2) AS rank FROM pages WHERE id=$1",
      [documentName, identity.userId],
    );
    if (!p.rowCount || p.rows[0].rank < 10) deny();
    connectionConfig.readOnly = p.rows[0].rank < 30;
    return { ...identity, spaceId: p.rows[0].space_id };
  },
  async connected({ connection }) {
    live.add(connection);
    connection.onClose(() => {
      live.delete(connection);
    });
  },
  async beforeHandleMessage({ connection }) {
    if (!ready()) deny();
    const rank = await authorization(
      db,
      connection.context,
      connection.document.name,
    );
    connection.readOnly = rank < 30;
  },
  async onLoadDocument({ documentName, document, context }) {
    await transaction(async (c) => {
      await authorization(c, context, documentName, true);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,3829))", [
        documentName,
      ]);
      const row = await c.query(
        "SELECT state FROM editor_documents WHERE page_id=$1 FOR UPDATE",
        [documentName],
      );
      if (row.rowCount) Y.applyUpdate(document, row.rows[0].state);
      else {
        const page = (
          await c.query("SELECT document FROM pages WHERE id=$1", [
            documentName,
          ])
        ).rows[0];
        const initial = documentToYDoc(page.document);
        const state = Y.encodeStateAsUpdate(initial);
        initial.destroy();
        await c.query(
          "INSERT INTO editor_documents(page_id,state) VALUES($1,$2)",
          [documentName, Buffer.from(state)],
        );
        Y.applyUpdate(document, state);
      }
    });
    const add = document.addConnection.bind(document);
    document.addConnection = (connection) => {
      guardOutbound(connection as Connection<Identity>);
      return add(connection);
    };
  },
  async beforeSync({ connection, documentName, type, payload }) {
    if (type === 0) return;
    if (type !== 1 && type !== 2) deny();
    if (!ready()) deny();
    await transaction(async (c) => {
      const rank = await authorization(
        c,
        connection.context,
        documentName,
        true,
      );
      connection.readOnly = rank < 30;
      if (connection.readOnly) return; // Hocuspocus refuses read-only sync updates and sends a negative acknowledgement.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,3829))", [
        documentName,
      ]);
      const row = await c.query(
        "SELECT state FROM editor_documents WHERE page_id=$1 FOR UPDATE",
        [documentName],
      );
      if (!row.rowCount) deny();
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, row.rows[0].state);
        Y.applyUpdate(candidate, payload);
        const next = Buffer.from(Y.encodeStateAsUpdate(candidate));
        if (next.length > 2 * 1024 * 1024) deny();
        const json = yDocToDocument(candidate);
        if (next.equals(row.rows[0].state)) return;
        await c.query(
          "UPDATE editor_documents SET state=$2,updated_at=now() WHERE page_id=$1",
          [documentName, next],
        );
        const p = (
          await c.query(
            "UPDATE pages SET document=$2,version=version+1 WHERE id=$1 RETURNING id,version,title,document",
            [documentName, json],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
          [p.id, p.version, p.title, p.document, connection.context.userId],
        );
      } finally {
        candidate.destroy();
      }
    });
  },
  async beforeHandleAwareness({ states, removedClients, awareness, context }) {
    if (!context) return;
    for (const [id, state] of states) {
      const previous = awareness.getStates().get(id);
      if (previous?.user?.id && previous.user.id !== context.userId) {
        states.delete(id);
        continue;
      }
      if (JSON.stringify(state).length > 8192) {
        states.delete(id);
        continue;
      }
      const color = ["#b69bff", "#69d9c1", "#f0b675", "#8cbdff"][
        createHash("sha256").update(context.userId).digest()[0] % 4
      ];
      states.set(id, {
        ...(state.cursor ? { cursor: state.cursor } : {}),
        user: { id: context.userId, name: context.email, color },
      });
    }
    for (const id of removedClients)
      if (awareness.getStates().get(id)?.user?.id !== context.userId)
        removedClients.delete(id);
  },
  async onRequest({ request, response }) {
    if (request.url !== "/health") {
      response.writeHead(404);
      response.end();
      throw null;
    }
    try {
      if (!ready()) throw Error();
      await db.query("SELECT 1");
      await redis.ping();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
    } catch {
      response.writeHead(503);
      response.end();
    }
    throw null;
  },
});
function redisLost() {
  if (stopping || poisoned) return;
  poisoned = true;
  for (const connection of live)
    connection.close({ code: 1013, reason: "Coordination unavailable" });
  console.error("Collaboration coordination lost; service restart required");
  extension.pub.disconnect(false);
  extension.sub.disconnect(false);
  redis.disconnect(false);
  setTimeout(() => process.exit(1), 50);
}
async function main() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
  await redis.ping();
  await server.listen();
  extension.pub.on("error", () => {});
  extension.sub.on("error", () => {});
  extension.pub.on("close", redisLost);
  extension.sub.on("close", redisLost);
  const interval = setInterval(() => void revalidate(), 500);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await server.destroy();
    await redis.quit();
    await db.end();
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  console.log("ORVYN_COLLABORATION_READY " + server.httpURL);
}
main().catch(() => {
  console.error("Collaboration startup failed; verify database and Redis");
  process.exit(1);
});
