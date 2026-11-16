import {
  normalizeDocument,
  documentSchemaVersion,
  documentHeadings,
} from "@orvyn/editor";
import {
  documentReferences,
  newDocumentAssets,
  documentExcerpt,
  validHeadingId,
} from "@orvyn/editor/links";
import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Req,
  Res,
  Body,
  Param,
  Query,
} from "@nestjs/common";
import { db, fail, text, mutation, user } from "./runtime.js";
import { appearanceInput } from "@orvyn/shared";
import { transaction, audit } from "./auth/security.js";
import {
  spaceAccess,
  pageAccess,
  pageWrite,
  subtree,
  memberRole,
  roleRanks,
  newPageParent,
} from "./permissions/access.js";
function documentInput(body: any) {
  if (!Number.isSafeInteger(body?.version))
    fail(400, "Invalid document version");
  let document;
  try {
    document = normalizeDocument(body?.document);
  } catch {
    return fail(400, "Invalid document");
  }
  return { title: text(body.title, 300), document, version: body.version };
}
@Controller("api/v1")
class PagesController {
  @Get("search") async search(
    @Req() req: any,
    @Query("q") input: unknown = "",
  ) {
    const uid = await user(req);
    if (typeof input !== "string" || input.length > 200)
      fail(400, "Invalid search query");
    const query = (input as string).trim();
    return (
      await db.query(
        `SELECT p.id,p.title,p.icon,p.parent_id,p.kind,p.space_id,s.name AS space_name,p.updated_at
      FROM pages p JOIN spaces s ON s.id=p.space_id
      WHERE (s.owner_id=$1 OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=$1))
      AND orvyn_page_role(p.id,$1)>=10 AND strpos(lower(p.title),lower($2))>0
      ORDER BY CASE WHEN lower(p.title)=lower($2) THEN 0 ELSE 1 END,p.updated_at DESC,p.id LIMIT 40`,
        [uid, query],
      )
    ).rows;
  }

  @Get("spaces/:id/pages") async list(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
    @Query("after") after = "",
    @Query("limit") input = "100",
    @Query("q") q = "",
  ) {
    const uid = await user(req),
      limit = Number(input);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      q.length > 200 ||
      after.length > 36
    )
      fail(400, "Invalid pagination");
    const r = await db.query(
      "SELECT p.*,orvyn_page_role(p.id,$2) AS access_rank FROM pages p WHERE p.space_id::text=$1 AND p.id::text>$3 AND orvyn_page_role(p.id,$2)>=10 AND strpos(lower(p.title),lower($5))>0 ORDER BY p.id LIMIT $4",
      [id, uid, after, limit + 1, q],
    );
    if (r.rows.length > limit) {
      r.rows.pop();
      res.setHeader("X-Next-Cursor", r.rows.at(-1).id);
    }
    return r.rows;
  }
  @Get("pages/:id") async get(@Req() req: any, @Param("id") id: string) {
    return pageAccess(db, await user(req), id);
  }
  @Get("pages/:id/preview") async preview(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
    @Query("heading") heading = "",
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    const p = await pageAccess(db, await user(req), id);
    if (heading && !validHeadingId(heading))
      fail(400, "Invalid heading reference");
    const space = (
      await db.query("SELECT name FROM spaces WHERE id=$1", [p.space_id])
    ).rows[0];
    return {
      id: p.id,
      title: p.title,
      kind: p.kind,
      spaceName: space.name,
      excerpt: p.kind === "database" ? "" : documentExcerpt(p.document),
      heading: heading
        ? documentHeadings(p.document).find((h) => h.id === heading) || null
        : null,
      missingHeading:
        !!heading &&
        !documentHeadings(p.document).some((h) => h.id === heading),
    };
  }
  @Get("pages/:id/backlinks") async backlinks(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
    @Query("after") after = "",
    @Query("limit") input = "50",
  ) {
    const uid = await user(req),
      limit = Number(input);
    await pageAccess(db, uid, id);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after && !/^[a-f0-9-]{36}$/.test(after))
    )
      fail(400, "Invalid pagination");
    const result = await db.query(
      `SELECT p.id,p.title,p.kind,p.space_id,s.name AS space_name
      FROM pages p JOIN spaces s ON s.id=p.space_id
      WHERE p.id<>$1::uuid AND p.id::text>$3 AND orvyn_page_role(p.id,$2)>=10
      AND EXISTS(SELECT 1 FROM page_references r WHERE r.source_id=p.id AND r.target_id=$1::uuid)
      ORDER BY p.id LIMIT $4`,
      [id, uid, after, limit + 1],
    );
    if (result.rows.length > limit) {
      result.rows.pop();
      res.setHeader("X-Next-Cursor", result.rows.at(-1).id);
    }
    return result.rows;
  }
  @Get("pages/:id/headings") async headings(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const page = await pageAccess(db, await user(req), id);
    return documentHeadings(page.document);
  }
  @Post("spaces/:id/pages") async create(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      title = text(body?.title, 300);
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 30, true);
      const parent = await newPageParent(c, uid, s.id, body.parentId);
      const r = await c.query(
        "INSERT INTO pages(space_id,title,parent_id,created_by,last_edited_by) VALUES($1,$2,$3,$4,$4) RETURNING *",
        [s.id, title, parent, uid],
      );
      const p = r.rows[0];
      await c.query(
        "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
        [p.id, p.version, p.title, p.document, uid],
      );
      await audit(c, uid, "page.created");
      return pageAccess(c, uid, p.id);
    });
  }
  @Put("pages/:id") async save(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      input = documentInput(body);
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id);
      if (p.document_schema_version > documentSchemaVersion)
        fail(409, "Document format requires a newer server");
      if (
        !(
          await c.query(
            "SELECT orvyn_editor_assets_allowed($1,$2::jsonb) AS allowed",
            [
              uid,
              JSON.stringify(newDocumentAssets(input.document, p.document)),
            ],
          )
        ).rows[0].allowed
      )
        fail(
          400,
          "An attachment is unavailable, inaccessible or not a supported image",
        );
      const editor = await c.query(
        "SELECT 1 FROM editor_documents WHERE page_id=$1",
        [p.id],
      );
      if (editor.rowCount)
        fail(409, "Edit this document through the collaboration connection");
      if (p.version !== input.version)
        fail(409, "Page changed; reload before saving");
      const r = await c.query(
        "UPDATE pages SET title=$1,document=$2,document_schema_version=$5,version=version+1,last_edited_by=$4 WHERE id=$3 RETURNING *",
        [input.title, input.document, p.id, uid, documentSchemaVersion],
      );
      const saved = r.rows[0];
      await c.query("SELECT orvyn_replace_page_references($1,$2::jsonb)", [
        saved.id,
        JSON.stringify(
          documentReferences(input.document, process.env.ORVYN_ORIGIN!),
        ),
      ]);
      await c.query(
        "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
        [saved.id, saved.version, saved.title, saved.document, uid],
      );
      await audit(c, uid, "page.updated");
      return { ...saved, access_rank: p.access_rank };
    });
  }
  @Patch("pages/:id/title") async title(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      title = text(body?.title, 300);
    if (!Number.isSafeInteger(body?.titleVersion))
      fail(400, "Title version required");
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id);
      if (p.title_version !== body.titleVersion)
        fail(409, "Title changed; reload first");
      const r = await c.query(
        "UPDATE pages SET title=$1,title_version=title_version+1,version=version+1,last_edited_by=$3 WHERE id=$2 RETURNING title,title_version",
        [title, p.id, uid],
      );
      await audit(c, uid, "page.title_updated");
      return r.rows[0];
    });
  }
  @Patch("pages/:id/appearance") async appearance(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      parsed = appearanceInput.safeParse(body);
    if (!parsed.success) fail(400, "Choose one emoji and a supported cover");
    const input = parsed.data!;
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id);
      if (input.appearanceVersion !== p.appearance_version)
        fail(409, "Appearance changed; reload before saving");
      if (input.coverFileId && input.coverFileId !== p.cover_file_id) {
        const file = await c.query(
          "SELECT 1 FROM files WHERE id=$1 AND page_id=$2 AND state='ready' AND media_type IN ('image/png','image/jpeg','image/gif','image/webp')",
          [input.coverFileId, p.id],
        );
        if (!file.rowCount)
          fail(400, "Choose an available image attached to this page");
      }
      const saved = await c.query(
        "UPDATE pages SET icon=$2,cover_preset=$3,cover_file_id=$4,appearance_version=appearance_version+1,version=version+1,last_edited_by=$5 WHERE id=$1 RETURNING id,icon,cover_preset,cover_file_id,appearance_version",
        [p.id, input.icon, input.coverPreset, input.coverFileId, uid],
      );
      await audit(c, uid, "page.appearance_updated");
      return saved.rows[0];
    });
  }
  @Get("pages/:id/permissions") async permissions(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req),
      p = await pageAccess(db, uid, id, 40);
    return {
      visibility: p.visibility,
      version: p.version,
      grants: (
        await db.query(
          'SELECT user_id AS "userId",role FROM page_permissions WHERE page_id=$1',
          [p.id],
        )
      ).rows,
    };
  }
  @Put("pages/:id/permissions") async setPermissions(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req);
    if (
      !["space", "restricted"].includes(body?.visibility) ||
      body?.confirm !== true ||
      !Array.isArray(body?.grants) ||
      body.grants.length > 1000 ||
      !Number.isSafeInteger(body?.version)
    )
      fail(400, "Explicit permission confirmation required");
    const grants = body.grants.map((g: any) => ({
      userId: text(g?.userId, 36),
      role: memberRole(g?.role),
    }));
    if (new Set(grants.map((g: any) => g.userId)).size !== grants.length)
      fail(400, "Duplicate permission grants");
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id, 40);
      if (p.version !== body.version)
        fail(409, "Permissions changed; reload first");
      for (const g of grants) {
        const m = await c.query(
          "SELECT role FROM space_members WHERE space_id=$1 AND user_id::text=$2",
          [p.space_id, g.userId],
        );
        if (
          !m.rowCount ||
          roleRanks[m.rows[0].role as keyof typeof roleRanks] <
            roleRanks[g.role as keyof typeof roleRanks]
        )
          fail(400, "Grant exceeds space membership");
      }
      await c.query("DELETE FROM page_permissions WHERE page_id=$1", [p.id]);
      for (const g of grants)
        await c.query("INSERT INTO page_permissions VALUES($1,$2,$3)", [
          p.id,
          g.userId,
          g.role,
        ]);
      await c.query(
        "UPDATE pages SET visibility=$1,version=version+1 WHERE id=$2",
        [body.visibility, p.id],
      );
      await c.query("UPDATE spaces SET version=version+1 WHERE id=$1", [
        p.space_id,
      ]);
      await audit(c, uid, "page.permissions_changed");
      return { ok: true };
    });
  }
  @Post("pages/:id/move") async move(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req);
    if (
      !Number.isSafeInteger(body?.version) ||
      !Number.isSafeInteger(body?.sortOrder) ||
      Math.abs(body.sortOrder) > 1000000
    )
      fail(400, "Page version and sort order required");
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id),
        descendants = await subtree(c, p.id);
      if (p.kind === "record" && body.parentId !== p.parent_id)
        fail(400, "Record pages must remain in their database");
      if (p.version !== body.version) fail(409, "Page changed; reload first");
      const denied = await c.query(
        "SELECT id FROM pages WHERE id=ANY($1::uuid[]) AND orvyn_page_role(id,$2,true)<30",
        [descendants.map((d) => d.id), uid],
      );
      if (denied.rowCount)
        fail(
          403,
          "Moving this hierarchy requires edit access to every descendant",
        );
      let parent = null,
        parentDepth = -1;
      if (body.parentId !== null) {
        const dest = await pageAccess(c, uid, text(body.parentId, 36), 30);
        if (dest.space_id !== p.space_id)
          fail(400, "Cross-space moves are not supported");
        if (descendants.some((d) => d.id === dest.id))
          fail(400, "Cannot move a page inside its descendants");
        parent = dest.id;
        const depth = await c.query(
          "WITH RECURSIVE a AS(SELECT id,parent_id,0 AS depth FROM pages WHERE id=$1 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN a ON a.parent_id=p.id WHERE a.depth<64) SELECT max(depth) AS depth FROM a",
          [parent],
        );
        parentDepth = depth.rows[0].depth;
      }
      if (parentDepth + 1 + Math.max(...descendants.map((d) => d.depth)) > 63)
        fail(400, "Page hierarchy exceeds 64 levels");
      // Freeze the old audience on the moved root so a new parent cannot broaden access.
      const audience = await c.query(
        "SELECT m.user_id,m.role,orvyn_page_role($1,m.user_id) AS rank FROM space_members m WHERE m.space_id=$2",
        [p.id, p.space_id],
      );
      await c.query("DELETE FROM page_permissions WHERE page_id=$1", [p.id]);
      for (const member of audience.rows.filter((m) => m.rank >= 10)) {
        const role = Object.entries(roleRanks).find(
          ([, rank]) => rank === member.rank,
        )![0];
        await c.query("INSERT INTO page_permissions VALUES($1,$2,$3)", [
          p.id,
          member.user_id,
          role,
        ]);
      }
      const r = await c.query(
        "UPDATE pages SET parent_id=$1,sort_order=$2,visibility='restricted',version=version+1 WHERE id=$3 RETURNING *",
        [parent, body.sortOrder, p.id],
      );
      await audit(c, uid, "page.moved");
      return pageAccess(c, uid, p.id);
    });
  }
  @Delete("pages/:id") async trash(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id),
        descendants = await subtree(c, p.id);
      if (descendants.length > 1 && body?.confirm !== true)
        fail(400, "Confirm moving this hierarchy to trash");
      const denied = await c.query(
        "SELECT id FROM pages WHERE id=ANY($1::uuid[]) AND orvyn_page_role(id,$2,true)<30",
        [descendants.map((d) => d.id), uid],
      );
      if (denied.rowCount)
        fail(
          403,
          "Deleting this hierarchy requires edit access to every descendant",
        );
      await c.query(
        "UPDATE pages SET deleted_at=now(),version=version+1 WHERE id=$1",
        [p.id],
      );
      await audit(c, uid, "page.trashed");
      return { ok: true };
    });
  }
  @Get("spaces/:id/trash") async listTrash(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req);
    return (
      await db.query(
        "SELECT p.id,p.title,p.parent_id,p.deleted_at,orvyn_page_role(p.id,$2,true) AS access_rank FROM pages p WHERE p.space_id::text=$1 AND p.deleted_at IS NOT NULL AND orvyn_page_role(p.id,$2,true)>=10 ORDER BY p.deleted_at DESC LIMIT 200",
        [id, uid],
      )
    ).rows;
  }
  @Post("pages/:id/restore") async restore(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const p = await pageWrite(c, uid, id, 30, true);
      if (!p.deleted_at) fail(409, "Page is not in trash");
      if (p.parent_id) await pageAccess(c, uid, p.parent_id, 30);
      const r = await c.query(
        "UPDATE pages SET deleted_at=NULL,version=version+1 WHERE id=$1 RETURNING *",
        [p.id],
      );
      await audit(c, uid, "page.restored");
      return r.rows[0];
    });
  }
  @Get("pages/:id/history") async history(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req),
      p = await pageAccess(db, uid, id);
    return (
      await db.query(
        "SELECT version,title,created_at FROM page_revisions WHERE page_id=$1 ORDER BY version DESC LIMIT 100",
        [p.id],
      )
    ).rows;
  }
  @Get("pages/:id/history/:version") async revision(
    @Req() req: any,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    const uid = await user(req),
      p = await pageAccess(db, uid, id);
    if (!/^\d{1,9}$/.test(version)) fail(400, "Invalid version");
    const r = await db.query(
      "SELECT version,title,document,created_at FROM page_revisions WHERE page_id=$1 AND version=$2",
      [p.id, Number(version)],
    );
    return r.rows[0] || fail(404, "Revision not found");
  }
}
@Module({ controllers: [PagesController] })
export class PagesModule {}
