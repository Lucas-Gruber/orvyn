import {
  Server,
  IncomingMessage,
  MessageType,
  type Connection,
} from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Redis as RedisClient } from "ioredis";
import { Pool, type PoolClient } from "pg";
import { databaseFingerprint, rollupDependencyState } from "@orvyn/shared";
import { authenticateCookie, databaseConfiguration } from "@orvyn/auth";
import {
  documentToYDoc,
  yDocToDocument,
  documentSchemaVersion,
} from "@orvyn/editor";
import * as Y from "yjs";
import { documentPeople } from "@orvyn/editor/mentions";
import { documentReferences, newDocumentAssets } from "@orvyn/editor/links";
import { createHash } from "node:crypto";
import { loadWhiteboard, saveWhiteboard } from "./whiteboards.js";
import { runtimeOrigin } from "@orvyn/shared/server";

type Identity = {
  userId: string;
  email: string;
  sessionHash: string;
  spaceId: string;
  kind: string;
  visibleRecords: Set<string>;
  notifiedRank: number;
  relationSignatures: string;
  relationProperties: string[] | null;
  polling: boolean;
  supportsPolling: boolean;
  lastPoll: number;
  watchGeneration: number;
};
const db = new Pool(databaseConfiguration());
const live = new Set<Connection<Identity>>();
let notificationsReady = false;
let stopping = false,
  poisoned = false,
  revalidating = false;
const origin = runtimeOrigin(process.env);
const redisOptions = { connectTimeout: 2000, maxRetriesPerRequest: 1 };
const redis = process.env.REDIS_URL
  ? new RedisClient(process.env.REDIS_URL, redisOptions)
  : new RedisClient({
      ...redisOptions,
      host: process.env.VALKEY_HOST || "127.0.0.1",
      port: Number(process.env.VALKEY_PORT || 6379),
      password: process.env.VALKEY_PASSWORD || undefined,
    });
redis.on("error", () => {});
const extension = new RedisExtension({
  redis,
  prefix: process.env.COLLABORATION_NAMESPACE || "orvyn:collaboration",
  lockTimeout: 0,
  disconnectDelay: 50,
});
function ready() {
  return (
    notificationsReady &&
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
    "SELECT kind,orvyn_page_role(id,$2) AS rank FROM pages WHERE id=$1",
    [pageId, identity.userId],
  );
  const rank = r.rows[0]?.rank || 0;
  if (rank < 10 || r.rows[0].kind !== identity.kind) deny();
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
async function relationSnapshot(
  connection: Connection<Identity>,
  skipDependencies = false,
) {
  if (!connection.context.visibleRecords.size)
    return { signature: "", fingerprint: null, polling: false };
  const row = (
    await db.query(
      `SELECT d.schema_version,
    CASE WHEN $5::boolean THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('pageId',r.page_id)||orvyn_rollup_watch_summary(d.page_id,r.page_id,$4::uuid[],$3::uuid)),'[]'::jsonb) FROM database_records r WHERE r.database_id=d.page_id AND r.page_id=ANY($2::uuid[]) AND orvyn_page_role(r.page_id,$3)>=10) END AS dependencies,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('pageId',p.id,'version',r.version) ORDER BY p.id),'[]'::jsonb) FROM database_records r JOIN pages p ON p.id=r.page_id WHERE r.database_id=d.page_id AND r.page_id=ANY($2::uuid[]) AND orvyn_page_role(p.id,$3)>=10) AS records,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',item.id,'revision',item.revision) ORDER BY item.id),'[]'::jsonb) FROM (
      SELECT DISTINCT target.id,concat_ws(':',target.version,target.title_version,target.appearance_version,tr.version,target_database.schema_version) AS revision
      FROM record_relations rr JOIN database_properties dp ON dp.id=rr.property_id AND dp.database_id=d.page_id AND dp.type='Relation' AND dp.deleted_at IS NULL
      JOIN database_records source_record ON source_record.page_id=rr.source_id AND source_record.database_id=dp.database_id
      JOIN pages source ON source.id=rr.source_id JOIN database_records tr ON tr.page_id=rr.target_id AND tr.database_id::text=dp.config->>'databaseId'
      JOIN databases target_database ON target_database.page_id=tr.database_id JOIN pages target ON target.id=rr.target_id
      WHERE rr.source_id=ANY($2::uuid[]) AND ($4::uuid[] IS NULL OR dp.id=ANY($4)) AND orvyn_page_role(source.id,$3)>=10 AND orvyn_page_role(target.id,$3)>=10
    ) item) AS targets FROM databases d WHERE d.page_id=$1`,
      [
        connection.document.name,
        [...connection.context.visibleRecords],
        connection.context.userId,
        connection.context.relationProperties,
        skipDependencies,
      ],
    )
  ).rows[0];
  if (!row) return { signature: "", fingerprint: null, polling: false };
  const dependencies = skipDependencies
    ? { token: "poll", polling: true }
    : rollupDependencyState(row.dependencies);
  return {
    signature:
      row.targets.length || dependencies.token
        ? JSON.stringify([row.targets, dependencies.token || null])
        : "",
    polling: dependencies.polling,
    fingerprint: databaseFingerprint(
      row.schema_version,
      row.records,
      row.targets,
      connection.context.relationProperties || [],
      dependencies.token,
    ),
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
          const { signature } = await relationSnapshot(
            connection,
            connection.context.polling,
          );
          if (signature !== connection.context.relationSignatures) {
            connection.context.relationSignatures = signature;
            connection.sendStateless(
              JSON.stringify({ type: "database-changed" }),
            );
          }
          if (
            connection.context.polling &&
            !connection.context.supportsPolling &&
            Date.now() - connection.context.lastPoll >= 5000
          ) {
            connection.context.lastPoll = Date.now();
            connection.sendStateless(
              JSON.stringify({ type: "database-changed" }),
            );
          }
          const readOnly = rank < 30;
          if (rank !== connection.context.notifiedRank) {
            connection.context.notifiedRank = rank;
            connection.readOnly = readOnly;
            connection.sendStateless(
              JSON.stringify({
                type: "permissions",
                readOnly,
                accessRank: rank,
              }),
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
      "SELECT space_id,kind,orvyn_page_role(id,$2) AS rank FROM pages WHERE id=$1",
      [documentName, identity.userId],
    );
    if (!p.rowCount || p.rows[0].rank < 10) deny();
    connectionConfig.readOnly = p.rows[0].rank < 30;
    return {
      ...identity,
      spaceId: p.rows[0].space_id,
      kind: p.rows[0].kind,
      visibleRecords: new Set<string>(),
      notifiedRank: p.rows[0].rank,
      relationSignatures: "",
      relationProperties: null,
      polling: false,
      supportsPolling: false,
      lastPoll: 0,
      watchGeneration: 0,
    };
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
      if (context.kind === "whiteboard") {
        await loadWhiteboard(c, documentName, document);
        return;
      }
      const schema = (
        await c.query("SELECT document_schema_version FROM pages WHERE id=$1", [
          documentName,
        ])
      ).rows[0];
      if (schema.document_schema_version > documentSchemaVersion) deny();
      const row = await c.query(
        "SELECT e.state,p.document FROM editor_documents e JOIN pages p ON p.id=e.page_id WHERE e.page_id=$1 FOR UPDATE OF e",
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
      if (connection.context.kind === "whiteboard") {
        await saveWhiteboard(
          c,
          documentName,
          payload,
          connection.context.userId,
        );
        return;
      }
      const row = await c.query(
        "SELECT e.state,p.document FROM editor_documents e JOIN pages p ON p.id=e.page_id WHERE e.page_id=$1 FOR UPDATE OF e",
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
        const people = documentPeople(json),
          oldPeople = new Set(documentPeople(row.rows[0].document));
        if (
          !(
            await c.query(
              "SELECT orvyn_document_people_allowed($1,$2::uuid[]) AS allowed",
              [documentName, people.filter((id) => !oldPeople.has(id))],
            )
          ).rows[0].allowed
        )
          deny();
        const additions = newDocumentAssets(json, row.rows[0].document);
        if (
          additions.length &&
          !(
            await c.query(
              "SELECT orvyn_editor_assets_allowed($1,$2::jsonb) AS allowed",
              [connection.context.userId, JSON.stringify(additions)],
            )
          ).rows[0].allowed
        )
          deny();
        await c.query(
          "UPDATE editor_documents SET state=$2,updated_at=now() WHERE page_id=$1",
          [documentName, next],
        );
        const p = (
          await c.query(
            "UPDATE pages SET document=$2,document_schema_version=$4,version=version+1,last_edited_by=$3 WHERE id=$1 RETURNING id,version,title,document",
            [
              documentName,
              json,
              connection.context.userId,
              documentSchemaVersion,
            ],
          )
        ).rows[0];
        await c.query("SELECT orvyn_replace_page_references($1,$2::jsonb)", [
          p.id,
          JSON.stringify(documentReferences(json, origin)),
        ]);
        await c.query("SELECT orvyn_sync_document_people($1,$2,$3::uuid[])", [
          p.id,
          connection.context.userId,
          people,
        ]);
        await c.query(
          "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
          [p.id, p.version, p.title, p.document, connection.context.userId],
        );
        await c.query(
          "SELECT orvyn_record_activity($1,NULL,$2,'page.updated',10,true)",
          [p.id, connection.context.userId],
        );
      } finally {
        candidate.destroy();
      }
    });
  },
  async onStateless({ connection, documentName, payload }) {
    if (payload.length > 100000) deny();
    let data: any;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (data.type !== "watch-records") return;
    if (
      data.supportsPolling !== undefined &&
      typeof data.supportsPolling !== "boolean"
    )
      deny();
    if (
      data.watchId !== undefined &&
      (!Number.isSafeInteger(data.watchId) || data.watchId < 0)
    )
      deny();
    if (
      !Array.isArray(data.recordIds) ||
      data.recordIds.length > 2000 ||
      data.recordIds.some(
        (id: any) =>
          typeof id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            id,
          ),
      )
    )
      deny();
    if (
      data.relationProperties !== undefined &&
      (!Array.isArray(data.relationProperties) ||
        data.relationProperties.length > 50 ||
        data.relationProperties.some(
          (id: any) =>
            typeof id !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              id,
            ),
        ))
    )
      deny();
    if (
      data.fingerprint !== undefined &&
      (typeof data.fingerprint !== "string" ||
        !/^[a-f0-9]{16}$/.test(data.fingerprint))
    )
      deny();
    const generation = ++connection.context.watchGeneration;
    const relationProperties =
      data.relationProperties === undefined
        ? null
        : [...new Set<string>(data.relationProperties)];
    const ids = [...new Set(data.recordIds)];
    const rows = await db.query(
      "SELECT r.page_id FROM database_records r WHERE r.database_id=$1 AND r.page_id=ANY($2::uuid[]) AND orvyn_page_role(r.page_id,$3)>=10",
      [documentName, ids, connection.context.userId],
    );
    if (generation !== connection.context.watchGeneration) return;
    connection.context.relationProperties = relationProperties;
    connection.context.visibleRecords = new Set(
      rows.rows.map((r) => r.page_id),
    );
    const snapshot = await relationSnapshot(connection);
    if (generation !== connection.context.watchGeneration) return;
    connection.context.relationSignatures = snapshot.signature;
    connection.context.polling = snapshot.polling;
    connection.context.supportsPolling = data.supportsPolling === true;
    connection.context.lastPoll = Date.now();
    if (
      data.fingerprint &&
      snapshot.fingerprint &&
      data.fingerprint !== snapshot.fingerprint
    )
      connection.sendStateless(JSON.stringify({ type: "database-changed" }));
    if (rows.rows.length !== ids.length)
      connection.sendStateless(JSON.stringify({ type: "database-changed" }));
    connection.sendStateless(
      JSON.stringify({
        type: "records-watched",
        count: rows.rows.length,
        requiresPolling: snapshot.polling,
        watchId: data.watchId,
      }),
    );
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
  await redis.ping();
  const listener = await db.connect();
  await listener.query("LISTEN orvyn_database_changed");
  notificationsReady = true;
  listener.on("notification", (message) => {
    void (async () => {
      let data: any;
      try {
        data = JSON.parse(message.payload || "");
      } catch {
        return;
      }
      if (
        typeof data.databaseId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          data.databaseId,
        )
      )
        return;
      for (const connection of live) {
        if (connection.document.name !== data.databaseId) continue;
        try {
          if (data.recordId) {
            if (
              typeof data.recordId !== "string" ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
                data.recordId,
              )
            )
              continue;
            const r = await db.query(
              "SELECT orvyn_page_role($1,$2,true) AS rank",
              [data.recordId, connection.context.userId],
            );
            if (r.rows[0].rank < 10) {
              if (!connection.context.visibleRecords.has(data.recordId))
                continue;
              connection.context.visibleRecords.delete(data.recordId);
            }
          }
          connection.sendStateless(
            JSON.stringify({ type: "database-changed" }),
          );
        } catch {
          connection.close({
            code: 1013,
            reason: "Database coordination unavailable",
          });
        }
      }
    })();
  });
  listener.on("error", () => {
    if (stopping) return;
    notificationsReady = false;
    for (const connection of live)
      connection.close({
        code: 1013,
        reason: "Database coordination unavailable",
      });
    setTimeout(() => process.exit(1), 50);
  });
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
    listener.release();
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
