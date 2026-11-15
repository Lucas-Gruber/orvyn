import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Req,
  Res,
  Body,
  Param,
} from "@nestjs/common";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { db, derive, hash, fail, text, mutation, user } from "./runtime";
@Controller("api/v1")
class PagesController {
  @Get("spaces/:id/pages") async pages(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    return (
      await db.query(
        "SELECT p.* FROM pages p JOIN spaces s ON s.id=p.space_id WHERE s.id::text=$1 AND s.owner_id=$2 ORDER BY p.title",
        [id, await user(req)],
      )
    ).rows;
  }
  @Post("spaces/:id/pages") async addPage(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const r = await db.query(
      "INSERT INTO pages(space_id,title) SELECT id,$1 FROM spaces WHERE id::text=$2 AND owner_id=$3 RETURNING *",
      [text(body?.title, 300), id, await user(req)],
    );
    return r.rows[0] || fail(404, "Not found");
  }
  @Put("pages/:id") async save(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req);
    if (
      !Number.isSafeInteger(body?.version) ||
      body?.document?.type !== "doc" ||
      !Array.isArray(body.document.content) ||
      body.document.content.some(
        (n: any) => n?.type !== "paragraph" || typeof n.text !== "string",
      ) ||
      JSON.stringify(body.document).length > 100000
    )
      fail(400, "Invalid document");
    const r = await db.query(
      "UPDATE pages p SET title=$1,document=$2,version=version+1 FROM spaces s WHERE s.id=p.space_id AND s.owner_id=$3 AND p.id::text=$4 AND p.version=$5 RETURNING p.*",
      [text(body.title, 300), body.document, uid, id, body.version],
    );
    if (!r.rowCount)
      fail(409, "Page unavailable or changed; reload before saving");
    return r.rows[0];
  }
}
@Module({ controllers: [PagesController] })
export class PagesModule {}
