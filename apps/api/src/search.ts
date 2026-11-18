import { createHash } from "node:crypto";
import { z } from "@orvyn/shared";
import { db, fail } from "./runtime.js";

const searchInput = z
  .object({
    q: z
      .string()
      .max(200)
      .refine((value) => !value.includes("\0"))
      .default(""),
    spaceId: z.union([z.uuid(), z.literal("")]).default(""),
    kind: z
      .enum(["all", "page", "folder", "database", "record", "whiteboard"])
      .default("all"),
    scope: z.enum(["all", "title"]).default("all"),
    limit: z.coerce.number().int().min(1).max(100).default(40),
    after: z.string().max(1024).default(""),
  })
  .strict();
const cursorInput = z
  .object({
    query: z.string().regex(/^[a-f0-9]{64}$/),
    bucket: z.number().int().min(0).max(2),
    score: z.number().min(0).max(1),
    updated: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict();

export function searchExcerpt(text: string, terms: string[]) {
  if (!terms.length)
    return { excerpt: "", highlights: [] as { start: number; end: number }[] };
  const expression = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(expression, "giu");
  const first = pattern.exec(text);
  if (!first)
    return { excerpt: "", highlights: [] as { start: number; end: number }[] };
  let start = Math.max(0, first.index - 70),
    end = Math.min(
      text.length,
      Math.max(start + 240, first.index + first[0].length),
    );
  // Preserve surrogate pairs at excerpt boundaries.
  if (start && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
  const excerpt =
    (start ? "… " : "") +
    text.slice(start, end).replace(/\s/g, " ") +
    (end < text.length ? " …" : "");
  pattern.lastIndex = 0;
  const highlights = [...excerpt.matchAll(pattern)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }));
  return { excerpt, highlights };
}

export async function workspaceSearch(uid: string, raw: unknown) {
  const parsed = searchInput.safeParse(raw);
  if (!parsed.success) fail(400, "Invalid search query");
  const input = parsed.data!,
    query = input.q.trim();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([query, input.spaceId, input.kind, input.scope]))
    .digest("hex");
  let after: z.infer<typeof cursorInput> | undefined;
  if (input.after) {
    try {
      after = cursorInput.parse(
        JSON.parse(Buffer.from(input.after, "base64url").toString("utf8")),
      );
      if (after.query !== fingerprint) throw Error("Different query");
    } catch {
      fail(400, "Invalid search cursor");
    }
  }
  const pattern = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
  const result = await db.query(
    `
    WITH terms AS (SELECT orvyn_search_query($2) AS value,tsvector_to_array(to_tsvector('simple',$2)) AS lexemes), ranked AS (
      SELECT p.id,p.title,p.icon,p.parent_id,p.kind,p.space_id,s.name AS space_name,p.updated_at,
       CASE WHEN $6='all' AND $2<>'' THEN x.body_text ELSE '' END AS body_text,terms.lexemes,
       CASE WHEN $2='' OR lower(x.title_text)=lower($2) THEN 0
        WHEN x.title_text ILIKE $3 ESCAPE '\\' OR x.title_vector@@terms.value THEN 1 ELSE 2 END AS bucket,
       CASE WHEN $2='' THEN 0::double precision
        WHEN $6='title' THEN ts_rank_cd(x.title_vector,terms.value,32)::double precision
        ELSE ts_rank_cd(x.search_vector,terms.value,32)::double precision END AS score
      FROM page_search x JOIN pages p ON p.id=x.page_id JOIN spaces s ON s.id=p.space_id CROSS JOIN terms
      WHERE (s.owner_id=$1 OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=$1))
       AND orvyn_page_role(p.id,$1)>=10
       AND ($4::uuid IS NULL OR p.space_id=$4::uuid) AND ($5::text IS NULL OR p.kind=$5)
       AND ($2='' OR x.title_text ILIKE $3 ESCAPE '\\' OR ($6='all' AND x.search_vector@@terms.value) OR ($6='title' AND x.title_vector@@terms.value))
    )
    SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated
    FROM ranked
    WHERE $7::integer IS NULL OR bucket>$7
      OR (bucket=$7 AND score<$8::double precision)
      OR (bucket=$7 AND score=$8::double precision AND updated_at<$9::timestamptz)
      OR (bucket=$7 AND score=$8::double precision AND updated_at=$9::timestamptz AND id>$10::uuid)
    ORDER BY bucket,score DESC,updated_at DESC,id LIMIT $11`,
    [
      uid,
      query,
      pattern,
      input.spaceId || null,
      input.kind === "all" ? null : input.kind,
      input.scope,
      after?.bucket ?? null,
      after?.score ?? null,
      after?.updated ?? null,
      after?.id ?? null,
      input.limit + 1,
    ],
  );
  const more = result.rows.length > input.limit;
  if (more) result.rows.pop();
  const last = result.rows.at(-1);
  const cursor =
    more && last
      ? Buffer.from(
          JSON.stringify({
            query: fingerprint,
            bucket: last.bucket,
            score: last.score,
            updated: last.cursor_updated,
            id: last.id,
          }),
        ).toString("base64url")
      : "";
  return {
    cursor,
    results: result.rows.map(
      ({
        body_text,
        lexemes,
        bucket,
        score: _score,
        cursor_updated: _updated,
        ...page
      }) => ({
        ...page,
        match_source: !query ? "recent" : bucket === 2 ? "content" : "title",
        ...(input.scope === "all" && query
          ? searchExcerpt(body_text, lexemes)
          : { excerpt: "", highlights: [] }),
      }),
    ),
  };
}
