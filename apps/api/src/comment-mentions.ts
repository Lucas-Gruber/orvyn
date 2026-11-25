import type { PoolClient } from "pg";
import { fail } from "./runtime.js";

export async function mentionPeople(
  c: PoolClient,
  page: any,
  query = "",
  ids?: string[],
  limit = 20,
) {
  return (
    await c.query(
      `SELECT u.id,u.display_name AS "displayName" FROM users u JOIN spaces s ON s.id=$1
     WHERE (u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id))
     AND ($3::uuid[] IS NULL OR u.id=ANY($3)) AND strpos(lower(u.display_name),lower($4))>0
     AND orvyn_page_role($2,u.id)>=10 ORDER BY u.display_name,u.id LIMIT $5`,
      [page.space_id, page.id, ids || null, query, limit],
    )
  ).rows as { id: string; displayName: string }[];
}
export async function syncCommentMentions(
  c: PoolClient,
  page: any,
  actor: string,
  messageId: string,
  recipients: string[],
  body: string,
) {
  const ids = [...new Set(recipients)],
    people = ids.length ? await mentionPeople(c, page, "", ids) : [],
    old = (
      await c.query(
        "SELECT user_id,label FROM comment_mentions WHERE comment_id=$1",
        [messageId],
      )
    ).rows,
    labels = new Map(
      people.map((p) => [
        p.id,
        body.includes("@" + p.displayName)
          ? p.displayName
          : old.find(
              (r) =>
                r.user_id === p.id && r.label && body.includes("@" + r.label),
            )?.label,
      ]),
    );
  if (people.length !== ids.length || people.some((p) => !labels.get(p.id)))
    fail(400, "Choose current page readers from the mention menu");
  await c.query(
    "DELETE FROM comment_mentions WHERE comment_id=$1 AND NOT(user_id=ANY($2::uuid[]))",
    [messageId, ids],
  );
  await c.query(
    "DELETE FROM notifications WHERE comment_id=$1 AND kind='comment_mention' AND NOT(recipient_id=ANY($2::uuid[]))",
    [messageId, ids],
  );
  for (const id of ids) {
    await c.query(
      "INSERT INTO comment_mentions(comment_id,user_id,label) VALUES($1,$2,$3) ON CONFLICT(comment_id,user_id) DO UPDATE SET label=excluded.label",
      [messageId, id, labels.get(id)],
    );
    if (id === actor || old.some((r) => r.user_id === id)) continue;
    await c.query(
      `INSERT INTO notifications(recipient_id,page_id,actor_id,kind,comment_id,thread_id)
      SELECT $1,$2,$3,'comment_mention',id,thread_id FROM comments WHERE id=$4
      ON CONFLICT(recipient_id,comment_id) DO UPDATE SET kind='comment_mention',read_at=NULL,created_at=clock_timestamp()`,
      [id, page.id, actor, messageId],
    );
  }
}
export async function notifyThreadReply(
  c: PoolClient,
  page: any,
  actor: string,
  threadId: string,
  messageId: string,
) {
  // Participants only, current readers only, one notification per recipient/message.
  // An explicit mention wins over the generic reply notification.
  await c.query(
    `INSERT INTO notifications(recipient_id,page_id,actor_id,kind,comment_id,thread_id)
    SELECT DISTINCT u.id,$1::uuid,$2::uuid,'thread_reply',$4::uuid,$3::uuid FROM users u JOIN spaces s ON s.id=$5
    WHERE u.id<>$2 AND (u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id))
    AND EXISTS(SELECT 1 FROM comments c WHERE c.thread_id=$3 AND c.author_id=u.id )
    AND orvyn_page_role($1,u.id)>=10 ON CONFLICT(recipient_id,comment_id) DO NOTHING`,
    [page.id, actor, threadId, messageId, page.space_id],
  );
}
