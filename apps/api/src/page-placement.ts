import type { PoolClient } from "pg";
import { fail } from "./runtime.js";
import { pageAccess } from "./permissions/access.js";

export interface PagePlacement {
  placement: "before" | "after" | "inside" | "root";
  targetId: string | null;
  targetParentId?: string | null;
}
export function placementInput(body: any): PagePlacement | null {
  if (!Object.hasOwn(body || {}, "placement")) return null;
  if (
    !["before", "after", "inside", "root"].includes(body.placement) ||
    (body.placement === "root"
      ? body.targetId !== null
      : typeof body.targetId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(body.targetId))
  )
    fail(400, "Invalid page destination");
  if (
    Object.hasOwn(body, "targetParentId") &&
    body.targetParentId !== null &&
    (typeof body.targetParentId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.targetParentId))
  )
    fail(400, "Invalid page destination");
  return {
    placement: body.placement,
    targetId: body.targetId,
    ...(Object.hasOwn(body, "targetParentId")
      ? { targetParentId: body.targetParentId }
      : {}),
  };
}
export async function placementParent(
  c: PoolClient,
  actor: string,
  page: any,
  input: PagePlacement,
) {
  if (page.kind === "record")
    fail(400, "Record pages must remain in their database");
  if (input.placement === "root") return null;
  const target = await pageAccess(c, actor, input.targetId!);
  if (target.space_id !== page.space_id)
    fail(400, "Cross-space moves are not supported");
  if (target.id === page.id) fail(400, "Choose another destination");
  if (
    ["before", "after"].includes(input.placement) &&
    Object.hasOwn(input, "targetParentId") &&
    target.parent_id !== input.targetParentId
  )
    fail(409, "Destination changed; reload the hierarchy");
  if (input.placement === "inside") {
    if (!["page", "folder"].includes(target.kind))
      fail(400, "Choose a page or folder as the parent");
    return target.id as string;
  }
  return target.parent_id as string | null;
}
export async function placementRank(
  c: PoolClient,
  page: any,
  parent: string | null,
  input: PagePlacement,
) {
  const load = async () =>
    (
      await c.query<{ id: string; sort_rank: number }>(
        "SELECT id,sort_rank FROM pages WHERE space_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND id<>$3 AND deleted_at IS NULL ORDER BY sort_rank,title,id",
        [page.space_id, parent, page.id],
      )
    ).rows;
  let siblings = await load();
  const index = () => {
    if (input.placement === "root" || input.placement === "inside")
      return siblings.length;
    const at = siblings.findIndex((p) => p.id === input.targetId);
    if (at < 0) fail(409, "Destination changed; reload the hierarchy");
    return at + (input.placement === "after" ? 1 : 0);
  };
  const rank = () => {
    const at = index(),
      previous = siblings[at - 1]?.sort_rank,
      next = siblings[at]?.sort_rank;
    return previous === undefined
      ? next === undefined
        ? 1024
        : next - 1024
      : next === undefined
        ? previous + 1024
        : previous + (next - previous) / 2;
  };
  let result = rank();
  const at = index();
  if (
    !Number.isFinite(result) ||
    Math.abs(result) > 1e12 ||
    (at > 0 &&
      at < siblings.length &&
      siblings[at]!.sort_rank - siblings[at - 1]!.sort_rank < 1e-5)
  ) {
    // Only internal ranks change. Other pages' timestamps, access versions and
    // activity notifications must not announce hidden siblings during compaction.
    await c.query(
      "WITH ranked AS(SELECT id,row_number() OVER(ORDER BY sort_rank,title,id)*1024 AS rank FROM pages WHERE space_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND id<>$3 AND deleted_at IS NULL) UPDATE pages p SET sort_rank=r.rank FROM ranked r WHERE p.id=r.id AND p.sort_rank IS DISTINCT FROM r.rank",
      [page.space_id, parent, page.id],
    );
    siblings = await load();
    result = rank();
  }
  return result;
}
