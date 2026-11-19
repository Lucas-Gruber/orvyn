import {
  Controller,
  Get,
  Post,
  Module,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import { db, fail, user, mutation } from "./runtime.js";
import { transaction } from "./auth/security.js";
import { pageWrite } from "./permissions/access.js";
import {
  validateWhiteboardScene,
  whiteboardSchemaVersion,
} from "@orvyn/editor/whiteboards";

@Controller("api/v1/pages/:id/whiteboard")
class Whiteboards {
  @Post("checkpoint") async checkpoint(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const page = await pageWrite(c, uid, id);
      if (page.kind !== "whiteboard") fail(404, "Whiteboard not found");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,3829))", [
        id,
      ]);
      const current = (
        await c.query(
          "SELECT version,scene FROM whiteboard_documents WHERE page_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!current) fail(404, "Whiteboard not found");
      await c.query(
        "INSERT INTO whiteboard_revisions(page_id,version,scene,author_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [id, current.version, current.scene, uid],
      );
      return { version: current.version };
    });
  }
  @Get() async get(@Req() req: any, @Param("id") id: string) {
    const uid = await user(req);
    const row = (
      await db.query(
        `SELECT p.id,p.title,p.space_id,orvyn_page_role(p.id,$2) AS access_rank,w.schema_version,w.version,w.scene
      FROM pages p JOIN whiteboard_documents w ON w.page_id=p.id WHERE p.id::text=$1 AND p.kind='whiteboard' AND orvyn_page_role(p.id,$2)>=10`,
        [id, uid],
      )
    ).rows[0];
    if (!row) return fail(404, "Whiteboard not found");
    if (row.schema_version > whiteboardSchemaVersion)
      fail(409, "Whiteboard format requires a newer application");
    return { ...row, scene: validateWhiteboardScene(row.scene) };
  }
  @Get("history") async history(
    @Req() req: any,
    @Param("id") id: string,
    @Query("before") before?: string,
  ) {
    const uid = await user(req),
      cursor = before === undefined ? 2147483647 : Number(before);
    if (!Number.isInteger(cursor) || cursor < 1 || cursor > 2147483647)
      fail(400, "Invalid history cursor");
    const allowed = await db.query(
      "SELECT id FROM pages WHERE id::text=$1 AND kind='whiteboard' AND orvyn_page_role(id,$2)>=10",
      [id, uid],
    );
    if (!allowed.rowCount) fail(404, "Whiteboard not found");
    const rows = (
      await db.query(
        `SELECT r.version,r.created_at,jsonb_array_length(r.scene->'elements') AS elements FROM whiteboard_revisions r
      JOIN pages p ON p.id=r.page_id WHERE p.id::text=$1 AND orvyn_page_role(p.id,$2)>=10 AND r.version<$3 ORDER BY r.version DESC LIMIT 21`,
        [id, uid, cursor],
      )
    ).rows;
    const more = rows.length > 20;
    if (more) rows.pop();
    return { revisions: rows, nextBefore: more ? rows.at(-1).version : null };
  }
  @Get("history/:version") async revision(
    @Req() req: any,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    if (!/^[1-9][0-9]{0,9}$/.test(version) || Number(version) > 2147483647)
      fail(400, "Invalid revision");
    const row = (
      await db.query(
        `SELECT r.version,r.created_at,r.scene FROM whiteboard_revisions r JOIN pages p ON p.id=r.page_id
      WHERE p.id::text=$1 AND p.kind='whiteboard' AND orvyn_page_role(p.id,$2)>=10 AND r.version=$3`,
        [id, await user(req), Number(version)],
      )
    ).rows[0];
    if (!row) fail(404, "Whiteboard revision not found");
    return row;
  }
}
@Module({ controllers: [Whiteboards] })
export class WhiteboardsModule {}
