import type { Pool, PoolClient } from "pg";
import { fail } from "../runtime.js";
export const roleRanks = {
  Owner: 50,
  Admin: 40,
  Editor: 30,
  Commenter: 20,
  Viewer: 10,
} as const;
export function memberRole(value: unknown) {
  if (
    typeof value !== "string" ||
    !["Admin", "Editor", "Commenter", "Viewer"].includes(value)
  )
    return fail(400, "Invalid member role");
  return value as Exclude<keyof typeof roleRanks, "Owner">;
}
export async function spaceAccess(
  c: Pool | PoolClient,
  uid: string,
  id: string,
  min = 10,
  lock = false,
) {
  const r = await c.query(
    `SELECT s.*,CASE WHEN s.owner_id=$2 THEN 'Owner' ELSE m.role END AS role FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$2 WHERE s.id::text=$1 ${lock ? "FOR UPDATE OF s" : ""}`,
    [id, uid],
  );
  const space = r.rows[0];
  if (
    !space ||
    !space.role ||
    roleRanks[space.role as keyof typeof roleRanks] < min
  )
    return fail(404, "Space not found");
  return space;
}
export async function pageAccess(
  c: Pool | PoolClient,
  uid: string,
  id: string,
  min = 10,
  includeDeleted = false,
) {
  const r = await c.query(
    "SELECT p.*,orvyn_page_role(p.id,$2,$3) AS access_rank FROM pages p WHERE p.id::text=$1",
    [id, uid, includeDeleted],
  );
  if (!r.rowCount || r.rows[0].access_rank < min)
    return fail(404, "Page not found");
  return r.rows[0];
}
export async function pageWrite(
  c: PoolClient,
  uid: string,
  id: string,
  min = 30,
  includeDeleted = false,
) {
  const found = await c.query("SELECT space_id FROM pages WHERE id::text=$1", [
    id,
  ]);
  if (!found.rowCount) return fail(404, "Page not found");
  await spaceAccess(c, uid, found.rows[0].space_id, 10, true);
  return pageAccess(c, uid, id, min, includeDeleted);
}
export async function subtree(c: PoolClient, id: string) {
  return (
    await c.query(
      `WITH RECURSIVE descendants AS (SELECT id,0 AS depth FROM pages WHERE id::text=$1 UNION ALL SELECT p.id,d.depth+1 FROM pages p JOIN descendants d ON p.parent_id=d.id WHERE d.depth<64) SELECT * FROM descendants`,
      [id],
    )
  ).rows as { id: string; depth: number }[];
}
export async function newPageParent(
  c: PoolClient,
  uid: string,
  spaceId: string,
  parentId: unknown,
  extraDepth = 0,
  childKind: "page" | "folder" | "database" | "record" | "whiteboard" = "page",
) {
  if (parentId === null || parentId === undefined) return null;
  if (typeof parentId !== "string") return fail(400, "Invalid parent page");
  const parent = await pageAccess(c, uid, parentId, 30);
  if (parent.kind === "database" && childKind !== "record")
    fail(400, "Only record pages belong directly inside a database");
  if (childKind === "record" && parent.kind !== "database")
    fail(400, "Record pages belong in a database");
  if (parent.space_id !== spaceId)
    return fail(400, "Parent must belong to this space");
  const d = await c.query(
    "WITH RECURSIVE a AS(SELECT id,parent_id,0 AS depth FROM pages WHERE id=$1 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN a ON a.parent_id=p.id WHERE a.depth<64) SELECT max(depth) AS depth FROM a",
    [parent.id],
  );
  if (d.rows[0].depth + 1 + extraDepth > 63)
    return fail(400, "Page hierarchy exceeds 64 levels");
  return parent.id as string;
}
