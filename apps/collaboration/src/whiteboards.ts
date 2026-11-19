import type { PoolClient } from "pg";
import * as Y from "yjs";
import { isDeepStrictEqual } from "node:util";
import {
  whiteboardFromYDoc,
  whiteboardToYDoc,
  whiteboardFiles,
  whiteboardText,
  validateWhiteboardScene,
  whiteboardSchemaVersion,
} from "@orvyn/editor/whiteboards";
function deny(): never {
  throw { code: 4403, reason: "Invalid whiteboard update" };
}
export async function loadWhiteboard(
  c: PoolClient,
  id: string,
  document: Y.Doc,
) {
  const row = (
    await c.query(
      "SELECT state,scene,schema_version FROM whiteboard_documents WHERE page_id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!row || row.schema_version > whiteboardSchemaVersion) deny();
  if (row.state) Y.applyUpdate(document, row.state);
  else {
    const initial = whiteboardToYDoc(validateWhiteboardScene(row.scene));
    try {
      const state = Buffer.from(Y.encodeStateAsUpdate(initial));
      await c.query(
        "UPDATE whiteboard_documents SET state=$2 WHERE page_id=$1",
        [id, state],
      );
      Y.applyUpdate(document, state);
    } finally {
      initial.destroy();
    }
  }
  whiteboardFromYDoc(document);
}
export async function saveWhiteboard(
  c: PoolClient,
  id: string,
  payload: Uint8Array,
  userId: string,
) {
  const row = (
    await c.query(
      "SELECT state,scene,schema_version,version FROM whiteboard_documents WHERE page_id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!row?.state || row.schema_version > whiteboardSchemaVersion) deny();
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, row.state);
    Y.applyUpdate(candidate, payload);
    const state = Buffer.from(Y.encodeStateAsUpdate(candidate));
    if (state.length > 2 * 1024 * 1024) deny();
    if (state.equals(row.state)) return;
    const scene = whiteboardFromYDoc(candidate),
      previous = validateWhiteboardScene(row.scene);
    const oldFiles = new Set(whiteboardFiles(previous)),
      additions = whiteboardFiles(scene).filter((id) => !oldFiles.has(id));
    if (additions.length) {
      const allowed = await c.query(
        "SELECT id FROM files WHERE id=ANY($1::uuid[]) AND page_id=$2 AND state='ready' AND media_type IN ('image/png','image/jpeg','image/gif','image/webp')",
        [additions, id],
      );
      if (allowed.rowCount !== additions.length) deny();
    }
    const changed = !isDeepStrictEqual(scene, previous);
    if (changed) {
      // Immutable recovery checkpoints, at most once every thirty seconds.
      // Current state and native per-user undo remain independent of history.
      await c.query(
        `INSERT INTO whiteboard_revisions(page_id,version,scene,author_id)
        SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM whiteboard_revisions WHERE page_id=$1 AND created_at>now()-interval '30 seconds')
        ON CONFLICT DO NOTHING`,
        [id, row.version, previous, userId],
      );
      await c.query(
        "UPDATE whiteboard_documents SET state=$2,scene=$3,search_text=$4,version=version+1,updated_at=now() WHERE page_id=$1",
        [id, state, scene, whiteboardText(scene)],
      );
      await c.query(
        "UPDATE pages SET version=version+1,last_edited_by=$2 WHERE id=$1",
        [id, userId],
      );
      await c.query(
        "SELECT orvyn_record_activity($1,NULL,$2,'page.updated',10,true)",
        [id, userId],
      );
    } else
      await c.query(
        "UPDATE whiteboard_documents SET state=$2 WHERE page_id=$1",
        [id, state],
      );
  } finally {
    candidate.destroy();
  }
}
