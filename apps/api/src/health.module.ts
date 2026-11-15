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
import { db, derive, hash, fail, text, mutation, user } from "./runtime.js";
@Controller("api/v1")
class HealthController {
  @Get("health") async health() {
    await db.query("SELECT 1");
    return { status: "ok" };
  }
}
@Module({ controllers: [HealthController] })
export class HealthModule {}
