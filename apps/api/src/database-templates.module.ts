import {
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Req,
  Param,
  Body,
  Query,
} from "@nestjs/common";
import { z } from "@orvyn/shared";
import { documentExcerpt } from "@orvyn/editor/links";
import { user, mutation, fail } from "./runtime.js";
import { transaction, audit } from "./auth/security.js";
import { spaceAccess } from "./permissions/access.js";
import { database, parse } from "./databases/model.js";
import {
  templateRow,
  templateSpaces,
  lockTemplateSpaces,
  templateMetadata,
  type TemplateRow,
} from "./databases/templates/model.js";
import {
  takeTemplateSnapshot,
  templateDefaults,
  readableTemplateFiles,
} from "./databases/templates/snapshot.js";
import {
  applyTemplate,
  applyTemplateInput,
} from "./databases/templates/apply.js";

const createInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["database", "record"]),
    recordId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => (v.kind === "record" ? !!v.recordId : !v.recordId));
const updateInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
    refresh: z.boolean().default(false),
  })
  .strict();
const removeInput = z.object({ version: z.number().int().positive() }).strict();

@Controller("api/v1")
class DatabaseTemplatesController {
  private async listing(
    uid: string,
    spaceId: string,
    kind: string,
    databaseId: string | null,
    q: unknown,
    before: unknown,
  ) {
    if (
      typeof q !== "string" ||
      q.length > 200 ||
      (before !== undefined &&
        (typeof before !== "string" || !z.uuid().safeParse(before).success))
    )
      fail(400, "Invalid template search.");
    return transaction(async (c) => {
      await c.query("SELECT id FROM spaces WHERE id::text=$1 FOR SHARE", [
        spaceId,
      ]);
      const space = await spaceAccess(c, uid, spaceId);
      if (databaseId) await database(c, uid, databaseId);
      const from = `FROM database_templates t JOIN pages source ON source.id=t.source_page_id AND source.space_id=t.space_id JOIN pages parent ON parent.id=t.database_id AND parent.space_id=t.space_id`,
        where = `t.space_id=$1 AND t.kind=$2 AND ($3::uuid IS NULL OR t.database_id=$3) AND orvyn_page_role(source.id,$4)>=10 AND orvyn_page_role(parent.id,$4)>=10 AND strpos(lower(t.name),lower($5))>0
          AND ((t.kind='database' AND source.id=t.database_id) OR (t.kind='record' AND EXISTS(SELECT 1 FROM database_records r WHERE r.page_id=source.id AND r.database_id=t.database_id)))`,
        values: unknown[] = [
          space.id,
          kind,
          databaseId,
          uid,
          (q as string).trim(),
        ];
      let cursor = "";
      if (before) {
        const row = (
          await c.query(
            `SELECT t.id,t.created_at ${from} WHERE ${where} AND t.id::text=$6`,
            [...values, before],
          )
        ).rows[0];
        if (!row) fail(404, "Template cursor is unavailable.");
        values.push(row.created_at, row.id);
        cursor = " AND (t.created_at,t.id)<($6,$7::uuid)";
      }
      const rows = (
          await c.query(
            `SELECT t.id,t.space_id,t.database_id,t.source_page_id,t.kind,t.name,t.version,t.created_by,t.created_at,t.updated_at,(orvyn_page_role(source.id,$4)>=30 AND orvyn_page_role(parent.id,$4)>=30) AS can_edit ${from} WHERE ${where}${cursor} ORDER BY t.created_at DESC,t.id DESC LIMIT 41`,
            values,
          )
        ).rows as TemplateRow[],
        more = rows.length > 40;
      if (more) rows.pop();
      return {
        templates: rows.map(templateMetadata),
        nextCursor: more ? rows.at(-1)!.id : null,
      };
    });
  }
  @Get("spaces/:id/templates") async listSpace(
    @Req() req: any,
    @Param("id") id: string,
    @Query("q") q: unknown = "",
    @Query("before") before?: unknown,
  ) {
    return this.listing(await user(req), id, "database", null, q, before);
  }
  @Get("databases/:id/templates") async listRecords(
    @Req() req: any,
    @Param("id") id: string,
    @Query("q") q: unknown = "",
    @Query("before") before?: unknown,
  ) {
    const uid = await user(req);
    const context = await transaction((c) => database(c, uid, id));
    return this.listing(
      uid,
      context.page.space_id,
      "record",
      context.page.id,
      q,
      before,
    );
  }
  @Get("templates/:id") async get(@Req() req: any, @Param("id") id: string) {
    const uid = await user(req);
    return transaction(async (c) => {
      const scope = await templateSpaces(c, uid, id);
      await lockTemplateSpaces(c, scope.spaces);
      const t = await templateRow(c, uid, id),
        context = await database(c, uid, t.database_id),
        files = await readableTemplateFiles(c, uid, t.payload.files);
      if (files.some((f) => !scope.spaces.includes(f.space_id)))
        fail(409, "Template attachments changed; try again.");
      const defaults =
        t.payload.kind === "record"
          ? await templateDefaults(c, uid, context, t.payload)
          : null;
      return {
        ...templateMetadata(t),
        preview:
          t.payload.kind === "database"
            ? {
                propertyCount: t.payload.properties.length,
                views: t.payload.views.map((v) => ({
                  name: v.name,
                  type: v.type,
                })),
                fileCount: files.length,
              }
            : {
                title: t.payload.title,
                excerpt: documentExcerpt(t.payload.document),
                values: defaults!.values,
                omittedDefaults: defaults!.omitted,
                fileCount: files.length,
              },
      };
    });
  }
  @Post("databases/:id/templates") async create(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof createInput>>(createInput, body);
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true),
        count = (
          await c.query(
            "SELECT count(*)::int AS n FROM database_templates WHERE space_id=$1 AND created_by=$2",
            [context.page.space_id, uid],
          )
        ).rows[0].n;
      if (count >= 100)
        fail(400, "Your template limit for this space has been reached.");
      const payload = await takeTemplateSnapshot(
        c,
        uid,
        context,
        input.recordId,
      );
      if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024)
        fail(413, "This template is too large.");
      const source = input.recordId || context.page.id,
        row = (
          await c.query(
            "INSERT INTO database_templates(space_id,database_id,source_page_id,kind,name,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              context.page.space_id,
              context.page.id,
              source,
              input.kind,
              input.name,
              payload,
              uid,
            ],
          )
        ).rows[0];
      await audit(c, uid, "database.template_created", { pageId: source });
      return { ...templateMetadata(row), canEdit: true };
    });
  }
  @Patch("templates/:id") async update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof updateInput>>(updateInput, body);
    return transaction(async (c) => {
      const initial = await templateRow(c, uid, id, 30),
        context = await database(c, uid, initial.database_id, 30, true),
        t = await templateRow(c, uid, id, 30);
      if (t.version !== input.version)
        fail(409, "Template changed; reload first.");
      const payload = input.refresh
        ? await takeTemplateSnapshot(
            c,
            uid,
            context,
            t.kind === "record" ? t.source_page_id : undefined,
          )
        : t.payload;
      if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024)
        fail(413, "This template is too large.");
      const row = (
        await c.query(
          "UPDATE database_templates SET name=$2,payload=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$4 RETURNING *",
          [t.id, input.name, payload, input.version],
        )
      ).rows[0];
      if (!row) fail(409, "Template changed; reload first.");
      await audit(c, uid, "database.template_updated", {
        pageId: t.source_page_id,
      });
      return { ...templateMetadata(row), canEdit: true };
    });
  }
  @Delete("templates/:id") async remove(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof removeInput>>(removeInput, body);
    return transaction(async (c) => {
      const initial = await templateRow(c, uid, id, 30);
      await database(c, uid, initial.database_id, 30, true);
      const t = await templateRow(c, uid, id, 30);
      if (t.version !== input.version)
        fail(409, "Template changed; reload first.");
      await c.query("DELETE FROM database_templates WHERE id=$1", [t.id]);
      await audit(c, uid, "database.template_deleted", {
        pageId: t.source_page_id,
      });
      return { removed: true };
    });
  }
  @Post("templates/:id/apply") async apply(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    return applyTemplate(
      await user(req),
      id,
      parse<z.infer<typeof applyTemplateInput>>(applyTemplateInput, body),
    );
  }
}
@Module({ controllers: [DatabaseTemplatesController] })
export class DatabaseTemplatesModule {}
