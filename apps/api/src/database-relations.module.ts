import { Module, Controller, Get, Req, Param, Query } from "@nestjs/common";
import { z } from "@orvyn/shared";
import { fail, user } from "./runtime.js";
import { transaction } from "./auth/security.js";
import { database } from "./databases/model.js";
import { targetProperties } from "./databases/rollup.js";
@Controller("api/v1/databases")
class DatabaseRelationsController {
  @Get(":id/properties/:property/target-properties") async properties(
    @Req() req: any,
    @Param("id") id: string,
    @Param("property") property: string,
  ) {
    const uid = await user(req);
    return transaction(async (c) => {
      await c.query(
        "SELECT s.id FROM spaces s JOIN pages p ON p.space_id=s.id WHERE p.id::text=$1 FOR SHARE OF s",
        [id],
      );
      const context = await database(c, uid, id),
        field =
          context.properties.find(
            (p) => p.id === property && p.type === "Relation",
          ) || fail(404, "Relation property not found");
      if (!field.config.databaseId)
        fail(404, "Related database is unavailable");
      const properties = await targetProperties(
        c,
        uid,
        context.page.space_id,
        field.config.databaseId!,
      );
      if (!properties) fail(404, "Related database is unavailable");
      return { properties };
    });
  }
  @Get(":id/properties/:property/records") async records(
    @Req() req: any,
    @Param("id") id: string,
    @Param("property") property: string,
    @Query("q") q = "",
    @Query("ids") input = "",
  ) {
    const uid = await user(req);
    if (
      typeof q !== "string" ||
      q.length > 200 ||
      typeof input !== "string" ||
      input.length > 1850
    )
      fail(400, "Invalid related record search");
    const ids = [...new Set(input ? input.split(",") : [])];
    if (ids.length > 50 || ids.some((id) => !z.uuid().safeParse(id).success))
      fail(400, "Invalid related record references");
    return transaction(async (c) => {
      await c.query(
        "SELECT s.id FROM spaces s JOIN pages p ON p.space_id=s.id WHERE p.id::text=$1 FOR SHARE OF s",
        [id],
      );
      const context = await database(c, uid, id),
        field =
          context.properties.find(
            (p) => p.id === property && p.type === "Relation",
          ) || fail(404, "Relation property not found");
      if (!z.uuid().safeParse(field.config.databaseId).success)
        fail(404, "Related database is unavailable");
      const target = (
        await c.query(
          "SELECT p.id,p.title FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.id=$1 AND p.space_id=$2 AND orvyn_page_role(p.id,$3)>=10",
          [field.config.databaseId, context.page.space_id, uid],
        )
      ).rows[0];
      if (!target) fail(404, "Related database is unavailable");
      const records = (
        await c.query(
          `SELECT p.id,p.title,p.icon FROM database_records r JOIN pages p ON p.id=r.page_id WHERE r.database_id=$1 AND orvyn_page_role(p.id,$2)>=10 AND (p.id=ANY($3::uuid[]) OR strpos(lower(p.title),lower($4))>0) ORDER BY (p.id=ANY($3::uuid[])) DESC,p.title,p.id LIMIT 70`,
          [target.id, uid, ids, q],
        )
      ).rows;
      return { database: { id: target.id, title: target.title }, records };
    });
  }
}
@Module({ controllers: [DatabaseRelationsController] })
export class DatabaseRelationsModule {}
