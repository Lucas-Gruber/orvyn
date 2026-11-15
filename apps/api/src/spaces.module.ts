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
class SpacesController {
  @Get("spaces") async spaces(@Req() req: any) {
    return (
      await db.query(
        "SELECT id,name FROM spaces WHERE owner_id=$1 ORDER BY name",
        [await user(req)],
      )
    ).rows;
  }
  @Post("spaces") async addSpace(@Req() req: any, @Body() body: any) {
    mutation(req);
    return (
      await db.query(
        "INSERT INTO spaces(owner_id,name) VALUES($1,$2) RETURNING id,name",
        [await user(req), text(body?.name, 120)],
      )
    ).rows[0];
  }
}
@Module({ controllers: [SpacesController] })
export class SpacesModule {}
