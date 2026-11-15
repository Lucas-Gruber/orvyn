import {
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Req,
  Body,
  Param,
  HttpCode,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  z,
  propertyInput,
  viewInput,
  queryInput,
  type QueryInput,
  type Property,
  type ViewConfig,
} from "@orvyn/shared";
import { db, fail, text, mutation, user } from "./runtime.js";
import { transaction, audit } from "./auth/security.js";
import {
  spaceAccess,
  pageAccess,
  newPageParent,
} from "./permissions/access.js";
import {
  database,
  parse,
  propertyConfig,
  propertyOptions,
  valuesFor,
  checkedView,
  querySql,
  recordDTO,
  recordSnapshot,
} from "./databases/model.js";
const recordInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    values: z.record(z.string(), z.json()).default({}),
    visibility: z.enum(["space", "restricted"]).default("space"),
  })
  .strict();
const patchInput = z
  .object({
    version: z.number().int().positive(),
    values: z.record(z.string(), z.json()),
  })
  .strict();
const emptyConfig: ViewConfig = {
  filters: [],
  sorts: [],
  visibleProperties: [],
  groupBy: null,
  dateProperty: null,
};
@Controller("api/v1")
class DatabasesController {
  @Get("spaces/:id/databases") async list(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req);
    return (
      await db.query(
        "SELECT p.id,p.title FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.space_id::text=$1 AND orvyn_page_role(p.id,$2)>=10 ORDER BY p.title LIMIT 200",
        [id, uid],
      )
    ).rows;
  }
  @Post("spaces/:id/databases") async create(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      name = text(body?.name, 120);
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 30, true),
        parent = await newPageParent(c, uid, s.id, body.parentId, 1);
      const p = (
        await c.query(
          "INSERT INTO pages(space_id,title,parent_id,kind,created_by,last_edited_by) VALUES($1,$2,$3,'database',$4,$4) RETURNING *",
          [s.id, name, parent, uid],
        )
      ).rows[0];
      await c.query("INSERT INTO databases(page_id) VALUES($1)", [p.id]);
      const titleId = randomUUID(),
        statusId = randomUUID(),
        dateId = randomUUID();
      await c.query(
        "INSERT INTO database_properties(id,database_id,name,type,position) VALUES($1,$2,'Name','Title',0)",
        [titleId, p.id],
      );
      const defaults = body?.includeDefaults !== false;
      if (defaults) {
        await c.query(
          "INSERT INTO database_properties(id,database_id,name,type,config,position) VALUES($1,$2,'Status','Status',$3,1),($4,$2,'Date','Date','{}',2)",
          [
            statusId,
            p.id,
            propertyOptions(["To do", "In progress", "Done"]),
            dateId,
          ],
        );
      }
      const types = defaults
        ? ["Table", "Board", "List", "Calendar", "Gallery"]
        : ["Table", "List", "Gallery"];
      for (const [position, type] of types.entries())
        await c.query(
          "INSERT INTO database_views(database_id,name,type,config,position) VALUES($1,$2,$2,$3,$4)",
          [
            p.id,
            type,
            {
              ...emptyConfig,
              groupBy: type === "Board" ? statusId : null,
              dateProperty: type === "Calendar" ? dateId : null,
            },
            position,
          ],
        );
      await c.query(
        "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
        [p.id, p.version, p.title, p.document, uid],
      );
      await audit(c, uid, "database.created");
      return { page: p, ...(await this.metadata(uid, p.id, c)) };
    });
  }
  private async metadata(uid: string, id: string, c: any = db) {
    const context = await database(c, uid, id);
    return {
      id: context.page.id,
      title: context.page.title,
      titleVersion: context.page.title_version,
      spaceId: context.page.space_id,
      pageVersion: context.page.version,
      accessRank: context.page.access_rank,
      schemaVersion: context.schemaVersion,
      properties: context.properties,
      views: context.views,
    };
  }
  @Get("databases/:id") async get(@Req() req: any, @Param("id") id: string) {
    return this.metadata(await user(req), id);
  }
  @Post("databases/:id/properties") async addProperty(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof propertyInput>>(propertyInput, body),
      config = propertyConfig(input);
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true);
      if (context.properties.length >= 50)
        fail(400, "A database supports up to 50 active properties");
      const position =
        Math.max(...context.properties.map((p) => p.position), -1) + 1;
      const r = await c.query(
        "INSERT INTO database_properties(database_id,name,type,config,position) VALUES($1,$2,$3,$4,$5) RETURNING id,name,type,config,position",
        [context.page.id, input.name, input.type, config, position],
      );
      await audit(c, uid, "database.property_created");
      return r.rows[0];
    });
  }
  @Patch("databases/:id/properties/:property") async renameProperty(
    @Req() req: any,
    @Param("id") id: string,
    @Param("property") property: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      name = text(body?.name, 80);
    if (!Number.isSafeInteger(body?.schemaVersion))
      fail(400, "Schema version required");
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true);
      if (context.schemaVersion !== body.schemaVersion)
        fail(409, "Database schema changed; reload first");
      const r = await c.query(
        "UPDATE database_properties SET name=$1 WHERE database_id=$2 AND id::text=$3 AND deleted_at IS NULL RETURNING id,name,type,config,position",
        [name, context.page.id, property],
      );
      if (!r.rowCount) fail(404, "Property not found");
      await audit(c, uid, "database.property_renamed");
      return r.rows[0];
    });
  }
  @Post("databases/:id/views") async addView(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof viewInput>>(viewInput, body);
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true);
      if (context.views.length >= 20)
        fail(400, "A database supports up to 20 views");
      checkedView(context.properties, input.type, input.config);
      querySql(
        context.properties,
        input.config,
        queryInput.parse({}),
        uid,
        context.page.id,
      );
      const r = await c.query(
        "INSERT INTO database_views(database_id,name,type,config,position) VALUES($1,$2,$3,$4,$5) RETURNING id,name,type,config,version",
        [
          context.page.id,
          input.name,
          input.type,
          input.config,
          context.views.length,
        ],
      );
      await audit(c, uid, "database.view_created");
      return r.rows[0];
    });
  }
  @Patch("databases/:id/views/:view") async updateView(
    @Req() req: any,
    @Param("id") id: string,
    @Param("view") view: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      schema = viewInput.extend({ version: z.number().int().positive() }),
      input = parse<z.infer<typeof schema>>(schema, body);
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true);
      checkedView(context.properties, input.type, input.config);
      querySql(
        context.properties,
        input.config,
        queryInput.parse({}),
        uid,
        context.page.id,
      );
      const r = await c.query(
        "UPDATE database_views SET name=$1,type=$2,config=$3,version=version+1 WHERE database_id=$4 AND id::text=$5 AND version=$6 RETURNING id,name,type,config,version",
        [
          input.name,
          input.type,
          input.config,
          context.page.id,
          view,
          input.version,
        ],
      );
      if (!r.rowCount) fail(409, "View changed or unavailable; reload first");
      await audit(c, uid, "database.view_updated");
      return r.rows[0];
    });
  }
  @Post("databases/:id/query") @HttpCode(200) async query(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<QueryInput>(queryInput, body),
      context = await database(db, uid, id);
    const view = input.viewId
      ? context.views.find((v) => v.id === input.viewId)
      : context.views[0];
    if (!view) return fail(404, "View not found");
    const config = checkedView(context.properties, view.type, view.config),
      query = querySql(context.properties, config, input, uid, context.page.id),
      rows = (await db.query(query.sql, query.params)).rows;
    const more = rows.length > input.limit;
    if (more) rows.pop();
    const visible = config.visibleProperties.length
      ? new Set([
          ...config.visibleProperties,
          ...context.properties
            .filter((p) => p.type === "Title")
            .map((p) => p.id),
          ...(config.groupBy ? [config.groupBy] : []),
          ...(config.dateProperty ? [config.dateProperty] : []),
        ])
      : null;
    const properties = visible
      ? context.properties.filter((p) => visible.has(p.id))
      : context.properties;
    return {
      records: rows.map((row) => recordDTO(row, properties)),
      nextOffset: more ? input.offset + input.limit : null,
      view,
      properties,
    };
  }
  @Post("databases/:id/records") async addRecord(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof recordInput>>(recordInput, body);
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true),
        values = valuesFor(context.properties, input.values);
      await newPageParent(c, uid, context.page.space_id, context.page.id);
      const p = (
        await c.query(
          "INSERT INTO pages(space_id,parent_id,title,kind,created_by,last_edited_by,visibility) VALUES($1,$2,$3,'record',$4,$4,$5) RETURNING *",
          [
            context.page.space_id,
            context.page.id,
            input.title,
            uid,
            input.visibility,
          ],
        )
      ).rows[0];
      if (input.visibility === "restricted") {
        const space = (
          await c.query("SELECT owner_id FROM spaces WHERE id=$1", [
            context.page.space_id,
          ])
        ).rows[0];
        if (space.owner_id !== uid)
          await c.query("INSERT INTO page_permissions VALUES($1,$2,$3)", [
            p.id,
            uid,
            context.page.access_rank >= 40 ? "Admin" : "Editor",
          ]);
      }
      await c.query(
        "INSERT INTO database_records(page_id,database_id,values) VALUES($1,$2,$3)",
        [p.id, context.page.id, values],
      );
      await c.query(
        "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
        [p.id, p.version, p.title, p.document, uid],
      );
      await audit(c, uid, "database.record_created");
      return recordSnapshot(c, uid, context.page.id, p.id, context.properties);
    });
  }
  @Patch("databases/:id/records/:record") async patchRecord(
    @Req() req: any,
    @Param("id") id: string,
    @Param("record") record: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      input = parse<z.infer<typeof patchInput>>(patchInput, body);
    return transaction(async (c) => {
      const context = await database(c, uid, id, 30, true),
        page = await pageAccess(c, uid, record, 30),
        values = valuesFor(context.properties, input.values);
      const r = await c.query(
        "UPDATE database_records SET values=values||$1::jsonb,version=version+1 WHERE page_id=$2 AND database_id=$3 AND version=$4 RETURNING page_id",
        [values, page.id, context.page.id, input.version],
      );
      if (!r.rowCount) fail(409, "Record changed or unavailable; reload first");
      await c.query("UPDATE pages SET last_edited_by=$1 WHERE id=$2", [
        uid,
        page.id,
      ]);
      await audit(c, uid, "database.record_updated");
      return recordSnapshot(
        c,
        uid,
        context.page.id,
        page.id,
        context.properties,
      );
    });
  }
}
@Module({ controllers: [DatabasesController] })
export class DatabasesModule {}
