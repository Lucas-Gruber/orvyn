import {
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Req,
  Body,
  Param,
  Query,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "@orvyn/shared";
import { fail, mutation, user } from "./runtime.js";
import { transaction, audit, rateLimit } from "./auth/security.js";
import { pageAccess, pageWrite } from "./permissions/access.js";

const messageInput = z
  .object({ body: z.string().trim().min(1).max(10000), requestId: z.uuid() })
  .strict();
const editInput = z
  .object({
    body: z.string().trim().min(1).max(10000),
    version: z.number().int().positive(),
  })
  .strict();
const resolveInput = z
  .object({ resolved: z.boolean(), version: z.number().int().positive() })
  .strict();
const deleteInput = z.object({ version: z.number().int().positive() }).strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const value = schema.safeParse(body);
  if (!value.success) fail(400, "Invalid comment input");
  return value.data!;
}
function pagination(cursor: string, input: string) {
  const limit = Number(input);
  if (
    (cursor && !z.uuid().safeParse(cursor).success) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    fail(400, "Invalid comment pagination");
  return limit;
}
async function context(
  c: PoolClient,
  uid: string,
  pageId: string,
  write = false,
) {
  try {
    if (write) return await pageWrite(c, uid, pageId, 20);
    // Permission changes lock the space exclusively; a shared read lock keeps
    // the role and all returned discussion content in the same authorization scope.
    const locked = await c.query(
      "SELECT s.id FROM spaces s JOIN pages p ON p.space_id=s.id WHERE p.id::text=$1 FOR SHARE OF s",
      [pageId],
    );
    if (!locked.rowCount) fail(404, "Page not found");
    return await pageAccess(c, uid, pageId);
  } catch (e: any) {
    if (e.getStatus?.() === 404) fail(404, "Page not found");
    throw e;
  }
}
async function threadContext(
  c: PoolClient,
  uid: string,
  id: string,
  write = false,
) {
  const found = (
    await c.query(
      "SELECT page_id FROM comment_threads WHERE id::text=$1 AND deleted_at IS NULL",
      [id],
    )
  ).rows[0];
  if (!found) fail(404, "Thread not found");
  let page;
  try {
    page = await context(c, uid, found.page_id, write);
  } catch (e: any) {
    if (e.getStatus?.() === 404) fail(404, "Thread not found");
    throw e;
  }
  const thread = (
    await c.query(
      "SELECT * FROM comment_threads WHERE id::text=$1 AND deleted_at IS NULL",
      [id],
    )
  ).rows[0];
  if (!thread) fail(404, "Thread not found");
  return { page, thread };
}
function threadDTO(t: any, page: any, uid: string) {
  return {
    id: t.id,
    pageId: t.page_id,
    version: t.version,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    resolvedAt: t.resolved_at,
    canResolve:
      page.access_rank >= 30 ||
      (page.access_rank >= 20 && t.created_by === uid),
    preview: t.preview || "",
    deletedPreview: !!t.deleted_preview,
    replyCount: Math.max(0, Number(t.message_count || 1) - 1),
    author: { id: t.created_by, email: t.author_email || null },
  };
}
const authorName =
  "CASE WHEN u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id) THEN u.email ELSE NULL END";
const threadColumns = `t.*,${authorName} AS author_email,(SELECT left(c.body,280) FROM comments c WHERE c.thread_id=t.id ORDER BY c.created_at,c.id LIMIT 1) AS preview,(SELECT c.deleted_at IS NOT NULL FROM comments c WHERE c.thread_id=t.id ORDER BY c.created_at,c.id LIMIT 1) AS deleted_preview,(SELECT count(*) FROM comments c WHERE c.thread_id=t.id) AS message_count`;
const threadFrom =
  "FROM comment_threads t JOIN pages p ON p.id=t.page_id JOIN spaces s ON s.id=p.space_id LEFT JOIN users u ON u.id=t.created_by";
async function detail(
  c: PoolClient,
  uid: string,
  page: any,
  threadId: string,
  before = "",
  limit = 50,
) {
  const t = (
    await c.query(
      `SELECT ${threadColumns} ${threadFrom} WHERE t.id=$1 AND t.page_id=$2 AND t.deleted_at IS NULL`,
      [threadId, page.id],
    )
  ).rows[0];
  if (!t) fail(404, "Thread not found");
  const messages = (
    await c.query(
      `SELECT c.*,${authorName} AS author_email FROM comments c JOIN comment_threads t ON t.id=c.thread_id JOIN pages p ON p.id=t.page_id JOIN spaces s ON s.id=p.space_id LEFT JOIN users u ON u.id=c.author_id WHERE c.thread_id=$1 AND ($2='' OR (c.created_at,c.id)<(SELECT a.created_at,a.id FROM comments a WHERE a.thread_id=$1 AND a.id::text=$2)) ORDER BY c.created_at DESC,c.id DESC LIMIT $3`,
      [threadId, before, limit + 1],
    )
  ).rows;
  const more = messages.length > limit;
  if (more) messages.pop();
  const nextBefore = more ? messages.at(-1).id : "";
  return {
    thread: threadDTO(t, page, uid),
    accessRank: page.access_rank,
    nextBefore,
    messages: messages.reverse().map((m) => ({
      id: m.id,
      version: m.version,
      body: m.deleted_at ? null : m.body,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deleted: !!m.deleted_at,
      author: { id: m.author_id, email: m.author_email || null },
      canEdit: !m.deleted_at && page.access_rank >= 20 && m.author_id === uid,
      canDelete:
        !m.deleted_at &&
        page.access_rank >= 20 &&
        (m.author_id === uid || page.access_rank >= 30),
    })),
  };
}
async function submitted(
  c: PoolClient,
  uid: string,
  page: any,
  input: z.infer<typeof messageInput>,
  threadId?: string,
) {
  const old = (
    await c.query(
      "SELECT c.body,c.thread_id,t.page_id,c.deleted_at,t.deleted_at AS thread_deleted FROM comments c JOIN comment_threads t ON t.id=c.thread_id WHERE c.author_id=$1 AND c.request_key=$2",
      [uid, input.requestId],
    )
  ).rows[0];
  if (!old) return null;
  if (
    old.page_id !== page.id ||
    (threadId && old.thread_id !== threadId) ||
    old.body !== input.body ||
    old.deleted_at ||
    old.thread_deleted
  )
    fail(409, "This draft was already submitted with different content");
  return detail(c, uid, page, old.thread_id);
}

@Controller("api/v1")
class CommentsController {
  @Get("pages/:id/threads") async list(
    @Req() req: any,
    @Param("id") id: string,
    @Query("before") before = "",
    @Query("limit") input = "20",
    @Query("state") state = "open",
  ) {
    const uid = await user(req),
      limit = pagination(before, input);
    if (!["open", "resolved", "all"].includes(state))
      fail(400, "Invalid thread filter");
    return transaction(async (c) => {
      const page = await context(c, uid, id),
        threads = (
          await c.query(
            `SELECT ${threadColumns} ${threadFrom} WHERE t.page_id=$1 AND t.deleted_at IS NULL AND ($2='all' OR (t.resolved_at IS NOT NULL)=($2='resolved')) AND ($3='' OR (t.created_at,t.id)<(SELECT a.created_at,a.id FROM comment_threads a WHERE a.page_id=$1 AND a.id::text=$3)) ORDER BY t.created_at DESC,t.id DESC LIMIT $4`,
            [page.id, state, before, limit + 1],
          )
        ).rows;
      const more = threads.length > limit;
      if (more) threads.pop();
      return {
        accessRank: page.access_rank,
        threads: threads.map((t) => threadDTO(t, page, uid)),
        nextBefore: more ? threads.at(-1).id : "",
      };
    });
  }
  @Post("pages/:id/threads") async create(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(messageInput, body);
    await rateLimit("comments:" + uid, 240);
    return transaction(async (c) => {
      const page = await context(c, uid, id, true),
        old = await submitted(c, uid, page, input);
      if (old) return old;
      const t = (
        await c.query(
          "INSERT INTO comment_threads(page_id,created_by) VALUES($1,$2) RETURNING id",
          [page.id, uid],
        )
      ).rows[0];
      const added = await c.query(
        "INSERT INTO comments(thread_id,author_id,body,request_key) VALUES($1,$2,$3,$4) ON CONFLICT(author_id,request_key) DO NOTHING RETURNING id",
        [t.id, uid, input.body, input.requestId],
      );
      if (!added.rowCount)
        fail(409, "This draft was already submitted; refresh before retrying");
      await audit(c, uid, "comment.thread_created");
      return detail(c, uid, page, t.id);
    });
  }
  @Get("threads/:id") async get(
    @Req() req: any,
    @Param("id") id: string,
    @Query("before") before = "",
    @Query("limit") input = "50",
  ) {
    const uid = await user(req),
      limit = pagination(before, input);
    return transaction(async (c) => {
      const { page, thread } = await threadContext(c, uid, id);
      return detail(c, uid, page, thread.id, before, limit);
    });
  }
  @Post("threads/:id/comments") async reply(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(messageInput, body);
    await rateLimit("comments:" + uid, 240);
    return transaction(async (c) => {
      const { page, thread } = await threadContext(c, uid, id, true),
        old = await submitted(c, uid, page, input, thread.id);
      if (old) return old;
      if (thread.resolved_at) fail(409, "Reopen this thread before replying");
      const added = await c.query(
        "INSERT INTO comments(thread_id,author_id,body,request_key) VALUES($1,$2,$3,$4) ON CONFLICT(author_id,request_key) DO NOTHING RETURNING id",
        [thread.id, uid, input.body, input.requestId],
      );
      if (!added.rowCount)
        fail(409, "This draft was already submitted; refresh before retrying");
      await c.query(
        "UPDATE comment_threads SET version=version+1,updated_at=now() WHERE id=$1",
        [thread.id],
      );
      await audit(c, uid, "comment.replied");
      return detail(c, uid, page, thread.id);
    });
  }
  @Patch("threads/:id") async resolve(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(resolveInput, body);
    return transaction(async (c) => {
      const { page, thread } = await threadContext(c, uid, id, true);
      if (page.access_rank < 30 && thread.created_by !== uid)
        fail(
          403,
          "Only the thread author or a page editor can resolve this discussion",
        );
      if (thread.version !== input.version)
        fail(409, "Thread changed; refresh before resolving");
      await c.query(
        "UPDATE comment_threads SET resolved_at=CASE WHEN $2 THEN now() ELSE NULL END,resolved_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1",
        [thread.id, input.resolved, uid],
      );
      await audit(
        c,
        uid,
        input.resolved ? "comment.resolved" : "comment.reopened",
      );
      return detail(c, uid, page, thread.id);
    });
  }
  async commentContext(c: PoolClient, uid: string, id: string) {
    const found = (
      await c.query("SELECT thread_id FROM comments WHERE id::text=$1", [id])
    ).rows[0];
    if (!found) fail(404, "Comment not found");
    let ctx;
    try {
      ctx = await threadContext(c, uid, found.thread_id, true);
    } catch (e: any) {
      if (e.getStatus?.() === 404) fail(404, "Comment not found");
      throw e;
    }
    const message = (
      await c.query("SELECT * FROM comments WHERE id::text=$1", [id])
    ).rows[0];
    if (!message) fail(404, "Comment not found");
    if (message.deleted_at) fail(409, "Comment was deleted");
    return { ...ctx, message };
  }
  @Patch("comments/:id") async edit(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(editInput, body);
    return transaction(async (c) => {
      const { page, thread, message } = await this.commentContext(c, uid, id);
      if (message.author_id !== uid)
        fail(403, "Only the author can edit a comment");
      if (message.version !== input.version)
        fail(409, "Comment changed; reload it before editing");
      await c.query(
        "UPDATE comments SET body=$2,version=version+1,edited_at=now() WHERE id=$1",
        [message.id, input.body],
      );
      await c.query(
        "UPDATE comment_threads SET version=version+1,updated_at=now() WHERE id=$1",
        [thread.id],
      );
      await audit(c, uid, "comment.edited");
      return detail(c, uid, page, thread.id);
    });
  }
  @Delete("comments/:id") async remove(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(deleteInput, body);
    return transaction(async (c) => {
      const { page, thread, message } = await this.commentContext(c, uid, id);
      if (message.author_id !== uid && page.access_rank < 30)
        fail(403, "Only the author or a page editor can delete a comment");
      if (message.version !== input.version)
        fail(409, "Comment changed; reload it before deleting");
      await c.query(
        "UPDATE comments SET body=NULL,version=version+1,deleted_at=now() WHERE id=$1",
        [message.id],
      );
      await c.query(
        "UPDATE comment_threads SET version=version+1,updated_at=now() WHERE id=$1",
        [thread.id],
      );
      await audit(c, uid, "comment.deleted");
      return detail(c, uid, page, thread.id);
    });
  }
}
@Module({ controllers: [CommentsController] })
export class CommentsModule {}
