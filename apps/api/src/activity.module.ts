import { Module, Controller, Get, Req, Param, Query } from "@nestjs/common";
import { z } from "@orvyn/shared";
import { fail, user } from "./runtime.js";
import { transaction } from "./auth/security.js";
import { spaceAccess, pageAccess, roleRanks } from "./permissions/access.js";
@Controller("api/v1")
class ActivityController {
  @Get("spaces/:id/activity") async list(
    @Req() req: any,
    @Param("id") id: string,
    @Query("page") page = "",
    @Query("before") before = "",
    @Query("limit") input = "40",
  ) {
    const uid = await user(req),
      limit = Number(input);
    if (
      (page && !z.uuid().safeParse(page).success) ||
      (before && !z.uuid().safeParse(before).success) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail(400, "Invalid activity pagination");
    return transaction(async (c) => {
      const locked = await c.query(
        "SELECT id FROM spaces WHERE id::text=$1 FOR SHARE",
        [id],
      );
      if (!locked.rowCount) fail(404, "Space not found");
      const space = await spaceAccess(c, uid, id),
        rank = roleRanks[space.role as keyof typeof roleRanks];
      if (page && (await pageAccess(c, uid, page)).space_id !== space.id)
        fail(404, "Page not found");
      const events = (
        await c.query(
          `SELECT a.id,a.kind,a.page_id,a.created_at,a.updated_at,p.title,p.icon,p.kind AS page_kind,a.actor_id,
        CASE WHEN u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id) THEN u.display_name ELSE NULL END AS actor_name
        FROM activity_events a JOIN spaces s ON s.id=a.space_id LEFT JOIN pages p ON p.id=a.page_id LEFT JOIN users u ON u.id=a.actor_id
        WHERE a.space_id=$1 AND ($3='' OR a.page_id::text=$3)
        AND CASE WHEN a.page_id IS NULL THEN $4>=a.min_rank ELSE orvyn_page_role(a.page_id,$2)>=a.min_rank END
        AND ($5='' OR (a.created_at,a.id)<(SELECT b.created_at,b.id FROM activity_events b WHERE b.id::text=$5 AND b.space_id=$1 AND ($3='' OR b.page_id::text=$3) AND CASE WHEN b.page_id IS NULL THEN $4>=b.min_rank ELSE orvyn_page_role(b.page_id,$2)>=b.min_rank END))
        ORDER BY a.created_at DESC,a.id DESC LIMIT $6`,
          [space.id, uid, page, rank, before, limit + 1],
        )
      ).rows;
      const more = events.length > limit;
      if (more) events.pop();
      return {
        events: events.map((e) => ({
          id: e.id,
          kind: e.kind,
          pageId: e.page_id,
          title: e.title,
          icon: e.icon,
          pageKind: e.page_kind,
          actor: { id: e.actor_id, displayName: e.actor_name || null },
          createdAt: e.created_at,
          updatedAt: e.updated_at,
        })),
        nextBefore: more ? events.at(-1).id : "",
      };
    });
  }
}
@Module({ controllers: [ActivityController] })
export class ActivityModule {}
