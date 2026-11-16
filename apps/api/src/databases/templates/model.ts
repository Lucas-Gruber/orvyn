import type { PoolClient } from "pg";
import { fail } from "../../runtime.js";
import type { TemplateSnapshot } from "./snapshot.js";

export interface TemplateRow {
  id: string;
  space_id: string;
  database_id: string;
  source_page_id: string;
  kind: "database" | "record";
  name: string;
  payload: TemplateSnapshot;
  version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  can_edit?: boolean;
}
export async function templateRow(
  c: PoolClient,
  uid: string,
  id: string,
  min = 10,
): Promise<TemplateRow> {
  const row = (
    await c.query(
      `SELECT t.*,(orvyn_page_role(source.id,$2)>=30 AND orvyn_page_role(parent.id,$2)>=30) AS can_edit FROM database_templates t JOIN pages source ON source.id=t.source_page_id AND source.space_id=t.space_id
    JOIN pages parent ON parent.id=t.database_id AND parent.space_id=t.space_id
    WHERE t.id::text=$1 AND orvyn_page_role(source.id,$2)>=$3 AND orvyn_page_role(parent.id,$2)>=10
    AND ((t.kind='database' AND source.id=t.database_id) OR (t.kind='record' AND EXISTS(SELECT 1 FROM database_records r WHERE r.page_id=source.id AND r.database_id=t.database_id)))`,
      [id, uid, min],
    )
  ).rows[0];
  return row || fail(404, "Template not found");
}
export const templateMetadata = (t: TemplateRow) => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  version: t.version,
  databaseId: t.database_id,
  sourcePageId: t.source_page_id,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  canEdit: !!t.can_edit,
});
export async function lockTemplateSpaces(c: PoolClient, spaces: string[]) {
  const unique = [...new Set(spaces)].sort();
  const result = await c.query(
    "SELECT id FROM spaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [unique],
  );
  if (result.rowCount !== unique.length) fail(404, "Template is unavailable");
}
export async function templateSpaces(c: PoolClient, uid: string, id: string) {
  const t = await templateRow(c, uid, id),
    spaces = t.payload.files.length
      ? (
          await c.query(
            "SELECT DISTINCT p.space_id FROM files f JOIN pages p ON p.id=f.page_id WHERE f.id=ANY($1::uuid[])",
            [t.payload.files],
          )
        ).rows.map((r) => r.space_id)
      : [];
  return { template: t, spaces: [...new Set<string>([t.space_id, ...spaces])] };
}
