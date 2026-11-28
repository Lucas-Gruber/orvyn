import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "@orvyn/shared";
import { documentSchemaVersion } from "@orvyn/editor";
import { exportMarkdown } from "@orvyn/editor/markdown-export";
import { pageLink } from "@orvyn/editor/links";
import { db, fail, hash, mutation, user } from "./runtime.js";
import { audit, origin, transaction } from "./auth/security.js";
import { spaceAccess } from "./permissions/access.js";

const input = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  spaceId: z.uuid().transform((id) => id.toLowerCase()),
  pageIds: z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .min(1)
    .max(100),
  expiresAt: z.iso.datetime(),
  confirm: z.literal(true),
});
const fields = `id,label,space_id AS "spaceId",scope,created_at AS "createdAt",
 expires_at AS "expiresAt",revoked_at AS "revokedAt"`;

@Controller("api/v1/integrations")
class IntegrationsController {
  // Management remains cookie-authenticated. Bearer credentials are never
  // accepted by user(), existing controllers, or the collaboration service.
  @Post("tokens") async create(@Req() req: any, @Body() body: unknown) {
    mutation(req);
    const uid = await user(req),
      parsed = input.safeParse(body);
    if (!parsed.success) fail(400, "Choose an explicit page scope and expiry");
    const value = parsed.data!,
      expires = new Date(value.expiresAt).getTime();
    if (expires <= Date.now() || expires > Date.now() + 30 * 86400000)
      fail(400, "Expiry must be in the next 30 days");
    if (new Set(value.pageIds).size !== value.pageIds.length)
      fail(400, "Choose each page once");
    return transaction(async (c) => {
      await spaceAccess(c, uid, value.spaceId, 10, true);
      const pages = await c.query(
        `SELECT id FROM pages WHERE id=ANY($1::uuid[]) AND space_id=$2
         AND kind IN ('page','record') AND orvyn_page_role(id,$3)>=10`,
        [value.pageIds, value.spaceId, uid],
      );
      if (pages.rowCount !== value.pageIds.length) fail(404, "Page not found");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "orvyn:integration-tokens:" + uid,
      ]);
      const active = await c.query(
        "SELECT count(*)::int AS count FROM integration_tokens WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()",
        [uid],
      );
      if (active.rows[0].count >= 20) fail(400, "Revoke an active token first");
      const token = "orvyn_agent_" + randomBytes(32).toString("hex");
      const created = (
        await c.query(
          `INSERT INTO integration_tokens(user_id,space_id,label,token_hash,expires_at)
         VALUES($1,$2,$3,$4,$5) RETURNING ${fields}`,
          [uid, value.spaceId, value.label, hash(token), value.expiresAt],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO integration_token_pages(token_id,page_id) SELECT $1,unnest($2::uuid[])",
        [created.id, value.pageIds],
      );
      await audit(c, uid, "integration.token_created");
      return { ...created, pageIds: value.pageIds, token };
    });
  }

  @Get("tokens") async list(@Req() req: any) {
    const uid = await user(req);
    return (
      await db.query(
        `SELECT ${fields},ARRAY(SELECT page_id FROM integration_token_pages p WHERE p.token_id=t.id ORDER BY page_id) AS "pageIds"
       FROM integration_tokens t WHERE user_id=$1
       ORDER BY (revoked_at IS NULL AND expires_at>now()) DESC,created_at DESC,id LIMIT 100`,
        [uid],
      )
    ).rows;
  }

  @Delete("tokens/:id") async revoke(@Req() req: any, @Param("id") id: string) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const result = await c.query(
        "UPDATE integration_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE id::text=$1 AND user_id=$2 RETURNING id",
        [id, uid],
      );
      if (!result.rowCount) fail(404, "Token not found");
      await audit(c, uid, "integration.token_revoked");
      return { ok: true };
    });
  }

  @Get("pages/:id") async read(@Req() req: any, @Param("id") id: string) {
    const token =
      typeof req.headers.authorization === "string"
        ? /^Bearer (orvyn_agent_[a-f0-9]{64})$/.exec(
            req.headers.authorization,
          )?.[1]
        : undefined;
    if (!token) fail(401, "A scoped integration token is required");
    // One statement checks expiry, revocation, exact scope, and current ACL.
    // Parent/child pages, files, linked databases and identities are not granted.
    const result = await db.query(
      `SELECT p.id,p.title,p.document,p.version,p.document_schema_version AS "documentSchemaVersion",p.updated_at AS "updatedAt"
       FROM integration_tokens t JOIN integration_token_pages g ON g.token_id=t.id
       JOIN pages p ON p.id=g.page_id AND p.space_id=t.space_id
       WHERE t.token_hash=$1 AND t.scope='pages:read' AND t.revoked_at IS NULL
       AND t.expires_at>now() AND p.id::text=$2 AND p.kind IN ('page','record')
       AND orvyn_page_role(p.id,t.user_id)>=10`,
      [hash(token!), id],
    );
    if (!result.rowCount) fail(404, "Page not found");
    const page = result.rows[0];
    if (page.documentSchemaVersion > documentSchemaVersion)
      fail(409, "This document requires a newer application");
    // Markdown never resolves linked resources using the issuer's wider access.
    let markdown: string | null = null,
      warnings: string[];
    try {
      const rendered = exportMarkdown(page.document, {
        title: page.title,
        pageUrl: new URL(pageLink(page.id), origin()).toString(),
        includePeopleNames: false,
        person: () => undefined,
        page: () => undefined,
        file: () => undefined,
      });
      markdown = rendered.markdown;
      warnings = rendered.warnings;
    } catch {
      // A valid 2 MiB document can exceed the separate 1 MiB Markdown budget.
      warnings = [
        "Markdown conversion is unavailable; use the structured document.",
      ];
    }
    return { source: "orvyn", scope: "pages:read", page, markdown, warnings };
  }
}

@Module({ controllers: [IntegrationsController] })
export class IntegrationsModule {}
