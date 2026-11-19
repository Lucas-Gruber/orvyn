import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Module,
  Req,
  Res,
  Param,
  Query,
  Body,
  StreamableFile,
  HttpException,
} from "@nestjs/common";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { Readable } from "node:stream";
import {
  z,
  publicationPreviewInput,
  publicationCommitInput,
  publicationChangeInput,
  queryInput,
  type PublicationInput,
} from "@orvyn/shared";
import { db, fail, hash, derive, mutation, user } from "../runtime.js";
import {
  audit,
  transaction,
  readSnapshot,
  encrypt,
  decrypt,
  rateLimit,
} from "../auth/security.js";
import { pageAccess, pageWrite } from "../permissions/access.js";
import { storage, bucket, GetObjectCommand } from "../files/storage.js";
import { database, querySql } from "../databases/model.js";
import { publicViewProperties, publicPropertyTypes } from "./databases.js";
import { publicationSnapshot } from "./snapshot.js";
import {
  signPublicationPreview,
  decodePublicationPreview,
  publicationDigest,
  publicToken,
  publicURL,
  publicationGateAllowed,
  publicationGateCookie,
} from "./security.js";

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  return result.success
    ? result.data
    : fail(400, result.error.issues[0]?.message || "Invalid input");
}
const health = `NOT EXISTS(SELECT 1 FROM publication_sources source LEFT JOIN pages page ON page.id=source.page_id
 WHERE source.publication_id=publication.id AND (page.id IS NULL OR orvyn_page_role(page.id,publication.publisher_id)<40))`;
function metadata(row: any) {
  return {
    id: row.id,
    label: row.label,
    url: publicURL(decrypt(row.token_encrypted)),
    scope: row.scope,
    version: row.version,
    enabled: row.enabled,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    expiresAt: row.expires_at,
    indexable: row.indexable,
    passwordProtected: !!row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pages: row.snapshot.pages.length,
    files: row.snapshot.files.length,
  };
}
async function target(
  c: PoolClient,
  root: string,
  input: PublicationInput,
  lock = false,
) {
  if (
    input.settings.expiresAt &&
    new Date(input.settings.expiresAt).getTime() <= Date.now()
  )
    fail(400, "Choose an expiry in the future");
  let row: any;
  if (input.target) {
    row = (
      await c.query(
        `SELECT * FROM publications WHERE id=$1 AND root_id=$2 ${lock ? "FOR UPDATE" : ""}`,
        [input.target.id, root],
      )
    ).rows[0];
    if (!row) fail(404, "Publication not found");
    if (row.revoked_at)
      fail(409, "This link was revoked. Review and create a new link.");
    if (row.version !== input.target.version)
      fail(409, "This publication changed. Review it again.");
  }
  if (
    input.settings.passwordProtected &&
    !input.settings.password &&
    !row?.password_hash
  )
    fail(400, "Set a password with at least 8 characters");
  return row;
}
@Controller("api/v1/pages/:root/publications")
class Publications {
  @Get() async list(@Req() req: any, @Param("root") root: string) {
    const uid = await user(req);
    await pageAccess(db, uid, root, 40);
    return (
      await db.query(
        "SELECT * FROM publications WHERE root_id::text=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
        [root],
      )
    ).rows.map(metadata);
  }
  @Get("choices") async choices(
    @Req() req: any,
    @Param("root") root: string,
    @Query("q") q = "",
    @Query("selected") selection = "",
  ) {
    const uid = await user(req);
    await pageAccess(db, uid, root, 40);
    const selected = selection
      ? parse(z.array(z.uuid()).max(100), selection.split(","))
      : [];
    const pages = (
      await db.query(
        `SELECT p.id,p.title,p.kind,p.parent_id,s.name AS space_name FROM pages p JOIN spaces s ON s.id=p.space_id
   WHERE p.kind IN ('page','folder','whiteboard','database') AND orvyn_page_role(p.id,$1)>=40 AND ($2='' OR strpos(lower(p.title),lower($2))>0 OR p.id=ANY($4::uuid[]))
   ORDER BY (p.id::text=$3) DESC,(p.id=ANY($4::uuid[])) DESC,p.title,p.id LIMIT 200`,
        [uid, q.slice(0, 200), root, selected],
      )
    ).rows;
    return { pages };
  }
  @Get("databases/:databaseId") async databaseChoices(
    @Req() req: any,
    @Param("root") root: string,
    @Param("databaseId") id: string,
  ) {
    const uid = await user(req);
    return readSnapshot(async (c) => {
      await pageAccess(c, uid, root, 40);
      const context = await database(c, uid, id, 40);
      return {
        id: context.page.id,
        title: context.page.title,
        schemaVersion: context.schemaVersion,
        views: context.views.map((view) => {
          const { config, properties } = publicViewProperties(context, view);
          return {
            id: view.id,
            name: view.name,
            type: view.type,
            version: view.version,
            properties: properties.map((property) => ({
              id: property.id,
              name: property.name,
              type: property.type,
              allowed: publicPropertyTypes.has(property.type),
            })),
            required: properties
              .filter(
                (property) =>
                  property.type === "Title" ||
                  (view.type === "Board" && property.id === config.groupBy) ||
                  (view.type === "Calendar" &&
                    property.id === config.dateProperty),
              )
              .map((property) => property.id),
          };
        }),
      };
    });
  }
  @Post("databases/:databaseId/records") async databaseRecords(
    @Req() req: any,
    @Param("root") root: string,
    @Param("databaseId") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(
        z.strictObject({
          viewId: z.uuid(),
          search: z.string().max(200).default(""),
          offset: z.number().int().min(0).max(1000000).default(0),
          selectedIds: z.array(z.uuid()).max(500).default([]),
        }),
        body,
      );
    return readSnapshot(async (c) => {
      await pageAccess(c, uid, root, 40);
      const context = await database(c, uid, id, 40),
        view =
          context.views.find((view) => view.id === input.viewId) ||
          fail(404, "Database view unavailable");
      const { config } = publicViewProperties(context, view),
        query = querySql(
          context.properties,
          config,
          queryInput.parse({
            viewId: input.viewId,
            search: input.search,
            offset: input.offset,
            limit: 100,
          }),
          uid,
          context.page.id,
          [],
          { minRank: 40, identitiesOnly: true },
        ),
        rows = (await c.query(query.sql, query.params)).rows;
      const selected: any[] = [];
      for (let offset = 0; offset < input.selectedIds.length; offset += 200) {
        const query = querySql(
          context.properties,
          config,
          queryInput.parse({ viewId: input.viewId, limit: 200, offset }),
          uid,
          context.page.id,
          [],
          { recordIds: input.selectedIds, minRank: 40, identitiesOnly: true },
        );
        selected.push(
          ...(await c.query(query.sql, query.params)).rows.slice(0, 200),
        );
      }
      return {
        selected: selected.map((row) => ({ id: row.id, title: row.title })),
        records: rows
          .slice(0, 100)
          .map((row) => ({ id: row.id, title: row.title })),
        nextOffset: rows.length > 100 ? input.offset + 100 : null,
      };
    });
  }
  @Post("preview") async preview(
    @Req() req: any,
    @Param("root") root: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(publicationPreviewInput, body);
    return readSnapshot(async (c) => {
      await pageAccess(c, uid, root, 40);
      await target(c, root, input);
      const plan = await publicationSnapshot(c, uid, root, input),
        digest = publicationDigest(input, plan);
      return {
        snapshot: plan.snapshot,
        warnings: plan.warnings,
        previewToken: signPublicationPreview({
          version: 1,
          actor: uid,
          root,
          target: input.target?.id || null,
          targetVersion: input.target?.version || null,
          digest,
          expires: Date.now() + 10 * 60 * 1000,
        }),
      };
    });
  }
  @Post() async publish(
    @Req() req: any,
    @Param("root") root: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      value = parse(publicationCommitInput, body),
      input = value.input,
      token = decodePublicationPreview(value.previewToken);
    if (
      token.actor !== uid ||
      token.root !== root ||
      token.target !== (input.target?.id || null) ||
      token.targetVersion !== (input.target?.version || null)
    )
      fail(400, "Preview does not match this publication");
    return transaction(async (c) => {
      await pageAccess(c, uid, root, 40);
      async function retry() {
        const previous = (
          await c.query(
            `SELECT request.digest,request.root_id,publication.* FROM publication_requests request JOIN publications publication ON publication.id=request.publication_id
     WHERE request.actor_id=$1 AND request.request_id=$2`,
            [uid, value.requestId],
          )
        ).rows[0];
        if (!previous) return null;
        if (previous.digest !== token.digest || previous.root_id !== root)
          fail(
            409,
            "This request was already used for a different publication",
          );
        return metadata(previous);
      }
      const previous = await retry();
      if (previous) return previous;
      if (token.expires <= Date.now())
        fail(409, "Preview expired. Review the publication again.");
      const plan = await publicationSnapshot(c, uid, root, input, true);
      const raced = await retry();
      if (raced) return raced;
      const old = await target(c, root, input, true);
      if (publicationDigest(input, plan) !== token.digest)
        fail(409, "Content changed since the preview. Review it again.");
      const salt = input.settings.passwordProtected
        ? input.settings.password
          ? randomBytes(16)
          : old.password_salt
        : null;
      const password = input.settings.passwordProtected
        ? input.settings.password
          ? await derive(input.settings.password, salt.toString("hex"))
          : old.password_hash
        : null;
      const secret = old
        ? decrypt(old.token_encrypted)
        : randomBytes(32).toString("base64url");
      const values = [
        root,
        uid,
        value.requestId,
        token.digest,
        hash(secret),
        encrypt(secret),
        input.settings.label,
        input.scope,
        plan.snapshot,
        input.settings.expiresAt,
        input.settings.indexable,
        salt,
        password,
      ];
      const row = old
        ? (
            await c.query(
              `UPDATE publications SET root_id=$1,token_hash=$5,token_encrypted=$6,publisher_id=$2,request_id=$3,request_digest=$4,label=$7,scope=$8,snapshot=$9,expires_at=$10,indexable=$11,password_salt=$12,password_hash=$13,
    enabled=true,version=version+1,updated_at=now() WHERE id=$14 RETURNING *`,
              [...values, old.id],
            )
          ).rows[0]
        : (
            await c.query(
              `INSERT INTO publications(root_id,publisher_id,request_id,request_digest,token_hash,token_encrypted,label,scope,snapshot,expires_at,indexable,password_salt,password_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
              values,
            )
          ).rows[0];
      await c.query("DELETE FROM publication_sources WHERE publication_id=$1", [
        row.id,
      ]);
      await c.query("DELETE FROM publication_files WHERE publication_id=$1", [
        row.id,
      ]);
      await c.query(
        "INSERT INTO publication_sources SELECT $1,unnest($2::uuid[])",
        [row.id, plan.sourceIds],
      );
      await c.query(
        "INSERT INTO publication_files SELECT $1,unnest($2::uuid[])",
        [row.id, plan.fileIds],
      );
      await c.query(
        "INSERT INTO publication_requests(actor_id,request_id,root_id,publication_id,digest) VALUES($1,$2,$3,$4,$5)",
        [uid, value.requestId, root, row.id, token.digest],
      );
      await audit(c, uid, old ? "publication.updated" : "publication.created", {
        pageId: root,
        minRank: 40,
      });
      return metadata(row);
    });
  }
  @Patch(":id") async change(
    @Req() req: any,
    @Param("root") root: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse(publicationChangeInput, body);
    return transaction(async (c) => {
      await pageWrite(c, uid, root, 40);
      const row = (
        await c.query(
          `SELECT publication.*,${health} AS healthy FROM publications publication WHERE id::text=$1 AND root_id::text=$2 FOR UPDATE`,
          [id, root],
        )
      ).rows[0];
      if (!row) fail(404, "Publication not found");
      if (row.version !== input.version || row.revoked_at)
        fail(409, "This publication changed or was revoked. Refresh the list.");
      if (input.enabled && !row.healthy)
        fail(409, "Source access changed. Review and create a new link.");
      const updated = (
        await c.query(
          "UPDATE publications SET enabled=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [row.id, input.enabled],
        )
      ).rows[0];
      await audit(
        c,
        uid,
        input.enabled ? "publication.enabled" : "publication.disabled",
        { pageId: root, minRank: 40 },
      );
      return metadata(updated);
    });
  }
  @Delete(":id") async revoke(
    @Req() req: any,
    @Param("root") root: string,
    @Param("id") id: string,
  ) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      await pageWrite(c, uid, root, 40);
      const row = (
        await c.query(
          "UPDATE publications SET revoked_at=coalesce(revoked_at,now()),revoked_reason=coalesce(revoked_reason,'owner'),version=version+1,updated_at=now() WHERE id::text=$1 AND root_id::text=$2 RETURNING id",
          [id, root],
        )
      ).rows[0];
      if (!row) fail(404, "Publication not found");
      await audit(c, uid, "publication.revoked", { pageId: root, minRank: 40 });
      return { revoked: true };
    });
  }
}
async function active(token: string, includeSnapshot = true) {
  if (!publicToken(token)) fail(404, "This link is unavailable");
  const row = (
    await db.query(
      `SELECT ${includeSnapshot ? "publication.*" : "publication.id,publication.version,publication.password_hash,publication.password_salt,publication.expires_at"} FROM publications publication WHERE token_hash=$1 AND enabled AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at>now()) AND ${health}`,
      [hash(token)],
    )
  ).rows[0];
  return row || fail(404, "This link is unavailable");
}
function headers(res: any, indexable = false) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "X-Robots-Tag",
    indexable ? "index, follow" : "noindex, nofollow, noarchive",
  );
}
function gate(req: any, row: any) {
  if (!publicationGateAllowed(req, row))
    throw new HttpException(
      { passwordRequired: true, message: "Enter the password for this link" },
      401,
    );
}
@Controller("api/v1/publications/:token")
class PublicReader {
  @Get() async get(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("token") token: string,
  ) {
    headers(res);
    const row = await active(token);
    gate(req, row);
    headers(res, row.indexable);
    return {
      version: row.version,
      snapshot: row.snapshot,
      indexable: row.indexable,
      publishedAt: row.updated_at,
    };
  }
  @Get("status") async status(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("token") token: string,
  ) {
    headers(res);
    const row = await active(token, false);
    gate(req, row);
    return { version: row.version };
  }
  @Post("unlock") async unlock(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("token") token: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    headers(res);
    const input = parse(
        z.strictObject({ password: z.string().max(256) }),
        body,
      ),
      row = await active(token);
    if (!row.password_hash) return { unlocked: true };
    // A bounded, hashed IP/token bucket protects the expensive password derivation.
    await rateLimit("publication-password:" + row.id + ":" + req.ip, 30);
    const key = await derive(input.password, row.password_salt.toString("hex"));
    if (
      key.length !== row.password_hash.length ||
      !timingSafeEqual(key, row.password_hash)
    )
      fail(403, "Incorrect password");
    const current = await active(token);
    if (current.version !== row.version)
      fail(409, "This link changed. Enter the password again.");
    res.setHeader("Set-Cookie", publicationGateCookie(current));
    return { unlocked: true };
  }
  @Get("files/:id") async file(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("token") token: string,
    @Param("id") id: string,
  ) {
    headers(res);
    const row = await active(token);
    gate(req, row);
    const description = row.snapshot.files.find((file: any) => file.id === id);
    if (!description) fail(404, "Attachment not included");
    const file = (
      await db.query(
        `SELECT f.* FROM publication_files grant_file JOIN files f ON f.id=grant_file.file_id
   WHERE grant_file.publication_id=$1 AND f.id::text=$2 AND f.state='ready' AND orvyn_page_role(f.page_id,$3)>=40`,
        [row.id, id, row.publisher_id],
      )
    ).rows[0];
    if (!file) fail(404, "Attachment unavailable");
    let object;
    try {
      object = await storage().send(
        new GetObjectCommand({ Bucket: bucket(), Key: file.object_key }),
      );
    } catch {
      fail(404, "Attachment unavailable");
    }
    const body = object?.Body;
    if (!(body instanceof Readable)) return fail(503, "Attachment unavailable");
    const inline = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ].includes(file.media_type);
    res.setHeader(
      "Content-Type",
      inline ? file.media_type : "application/octet-stream",
    );
    res.setHeader("Content-Length", file.size);
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(description.filename).replace(/['()*]/g, (value: string) => "%" + value.charCodeAt(0).toString(16))}`,
    );
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    return new StreamableFile(body);
  }
}
@Module({ controllers: [Publications, PublicReader] })
export class PublicationsModule {}
