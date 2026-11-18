import type { Pool, PoolClient } from "pg";
import { z, type Property } from "@orvyn/shared";
import { fail } from "../runtime.js";

export async function checkRelationTarget(
  c: Pool | PoolClient,
  uid: string,
  id: string,
) {
  if (!z.uuid().safeParse(id).success)
    fail(400, "Choose a currently accessible database");
  const target = await c.query(
    "SELECT d.page_id FROM databases d JOIN pages p ON p.id=d.page_id WHERE d.page_id=$1 AND orvyn_page_role(p.id,$2)>=10",
    [id, uid],
  );
  if (!target.rowCount) fail(400, "Choose a currently accessible database");
}
// Only current readable records are exposed. Previously stored inaccessible
// references survive edits to the visible selection rather than being erased.
export async function checkRelations(
  c: Pool | PoolClient,
  uid: string,
  properties: Property[],
  values: Record<string, unknown>,
  previous: Record<string, unknown> = {},
) {
  for (const property of properties) {
    if (property.type !== "Relation" || !Object.hasOwn(values, property.id))
      continue;
    const next = Array.isArray(values[property.id])
        ? (values[property.id] as string[])
        : [],
      old = Array.isArray(previous[property.id])
        ? (previous[property.id] as unknown[]).filter(
            (id): id is string =>
              typeof id === "string" && z.uuid().safeParse(id).success,
          )
        : [],
      all = [...new Set([...old, ...next])];
    const rows = all.length
        ? (
            await c.query(
              `SELECT p.id FROM database_records r JOIN pages p ON p.id=r.page_id WHERE r.database_id=$1 AND p.id=ANY($2::uuid[]) AND orvyn_page_role(p.id,$3)>=10`,
              [property.config.databaseId, all, uid],
            )
          ).rows
        : [],
      readable = new Set(rows.map((row) => row.id));
    if (next.some((id) => !readable.has(id)))
      fail(400, "Choose current readable records from the related database");
    values[property.id] = [
      ...new Set([...next, ...old.filter((id) => !readable.has(id))]),
    ].sort();
  }
}
