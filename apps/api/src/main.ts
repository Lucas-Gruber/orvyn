import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { migrate, db } from "./runtime.js";
import { encryptionKey } from "./auth/security.js";
import { OidcModule } from "./oidc.module.js";
import { DatabaseTransferModule } from "./databases/transfer.module.js";
import { DatabasesModule } from "./databases.module.js";
import { FilesModule } from "./files.module.js";
import { storageHealth } from "./files/storage.js";
import { AuthModule } from "./auth.module.js";
import { SpacesModule } from "./spaces.module.js";
import { PagesModule } from "./pages.module.js";
import { HealthModule } from "./health.module.js";
import { DatabaseRelationsModule } from "./database-relations.module.js";
import { DatabaseTemplatesModule } from "./database-templates.module.js";
import { DatabasePropertyConversionsModule } from "./database-property-conversions.module.js";
import { ActivityModule } from "./activity.module.js";
import { NotificationsModule } from "./notifications.module.js";
import { CommentsModule } from "./comments.module.js";
@Module({
  imports: [
    DatabaseTransferModule,
    DatabasesModule,
    FilesModule,
    OidcModule,
    AuthModule,
    SpacesModule,
    PagesModule,
    HealthModule,
    CommentsModule,
    NotificationsModule,
    ActivityModule,
    DatabaseRelationsModule,
    DatabaseTemplatesModule,
    DatabasePropertyConversionsModule,
  ],
})
class App {}
async function main() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
  encryptionKey();
  await migrate(db);
  await storageHealth();
  const app = await NestFactory.create(App);
  app.use((req: any, res: any, next: any) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  await app.listen(Number(process.env.PORT || 3001), "0.0.0.0");
  console.log("ORVYN_READY " + (await app.getUrl()));
}
main().catch(() => {
  console.error("API startup failed; verify database configuration");
  process.exit(1);
});
