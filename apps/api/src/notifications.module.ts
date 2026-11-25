import { commentBody, commentPeopleSql } from "./comment-people.js";
import {
  Module,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Body,
  Param,
  Query,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { documentExcerpt } from "@orvyn/editor/links";
import { z } from "@orvyn/shared";
import { fail, mutation, user } from "./runtime.js";
import { transaction } from "./auth/security.js";

async function lockSources(c: PoolClient, uid: string) {
  await c.query(
    `SELECT s.id FROM spaces s WHERE EXISTS(SELECT 1 FROM notifications n JOIN pages p ON p.id=n.page_id WHERE n.recipient_id=$1 AND p.space_id=s.id) ORDER BY s.id FOR SHARE OF s`,
    [uid],
  );
}
const visible = `n.recipient_id=$1 AND orvyn_page_role(p.id,$1)>=10 AND ((n.kind='document_mention' AND EXISTS(SELECT 1 FROM document_people dp WHERE dp.page_id=p.id AND dp.user_id=$1)) OR (n.kind<>'document_mention' AND c.id IS NOT NULL AND t.id IS NOT NULL AND c.deleted_at IS NULL AND t.deleted_at IS NULL))`;
const source = `FROM notifications n JOIN pages p ON p.id=n.page_id LEFT JOIN comment_threads t ON t.id=n.thread_id AND t.page_id=p.id LEFT JOIN comments c ON c.id=n.comment_id AND c.thread_id=t.id JOIN spaces s ON s.id=p.space_id LEFT JOIN users u ON u.id=n.actor_id`;
const columns = `n.*,p.title,p.space_id,CASE WHEN n.kind='document_mention' THEN p.document ELSE NULL END AS document,c.body AS excerpt,${commentPeopleSql("c.id")} AS mentions,CASE WHEN u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id) THEN u.display_name ELSE NULL END AS actor_name`;
function dto(n: any) {
  return {
    id: n.id,
    kind: n.kind,
    pageId: n.page_id,
    spaceId: n.space_id,
    threadId: n.thread_id,
    commentId: n.comment_id,
    title: n.title,
    excerpt:
      n.kind === "document_mention"
        ? documentExcerpt(n.document)
        : commentBody(n.excerpt || "", n.mentions).slice(0, 280),
    actor: { id: n.actor_id, displayName: n.actor_name || null },
    createdAt: n.created_at,
    readAt: n.read_at,
  };
}
async function one(c: PoolClient, uid: string, id: string) {
  const value = (
    await c.query(
      `SELECT ${columns} ${source} WHERE ${visible} AND n.id::text=$2`,
      [uid, id],
    )
  ).rows[0];
  if (!value) fail(404, "Notification not found");
  return value;
}
@Controller("api/v1")
class NotificationsController {
  @Get("notifications") async list(
    @Req() req: any,
    @Query("before") before = "",
    @Query("state") state = "all",
    @Query("limit") input = "20",
  ) {
    const uid = await user(req),
      limit = Number(input);
    if (
      (before && !z.uuid().safeParse(before).success) ||
      !["all", "unread"].includes(state) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail(400, "Invalid notification pagination");
    return transaction(async (c) => {
      await lockSources(c, uid);
      const items = (
        await c.query(
          `SELECT ${columns} ${source} WHERE ${visible} AND ($2='all' OR n.read_at IS NULL)
        AND ($3='' OR (n.created_at,n.id)<(SELECT a.created_at,a.id FROM notifications a WHERE a.recipient_id=$1 AND a.id::text=$3)) ORDER BY n.created_at DESC,n.id DESC LIMIT $4`,
          [uid, state, before, limit + 1],
        )
      ).rows;
      const more = items.length > limit;
      if (more) items.pop();
      const unread = (
        await c.query(
          `SELECT count(*)::int AS total ${source} WHERE ${visible} AND n.read_at IS NULL`,
          [uid],
        )
      ).rows[0].total;
      return {
        notifications: items.map(dto),
        nextBefore: more ? items.at(-1).id : "",
        unread,
      };
    });
  }
  @Patch("notifications/:id") async mark(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = z.object({ read: z.boolean() }).strict().safeParse(body);
    if (!input.success) fail(400, "Choose read or unread");
    return transaction(async (c) => {
      await lockSources(c, uid);
      await one(c, uid, id);
      await c.query(
        "UPDATE notifications SET read_at=CASE WHEN $3 THEN coalesce(read_at,clock_timestamp()) ELSE NULL END WHERE id::text=$2 AND recipient_id=$1",
        [uid, id, input.data!.read],
      );
      return dto(await one(c, uid, id));
    });
  }
  @Post("notifications/read-all") async all(
    @Req() req: any,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req);
    if (!z.object({}).strict().safeParse(body).success)
      fail(400, "Invalid notification input");
    return transaction(async (c) => {
      await lockSources(c, uid);
      await c.query(
        `UPDATE notifications SET read_at=clock_timestamp() WHERE id IN(SELECT n.id ${source} WHERE ${visible} AND n.read_at IS NULL)`,
        [uid],
      );
      return { ok: true };
    });
  }
}
@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
