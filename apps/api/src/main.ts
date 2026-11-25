import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { migrate, db } from "./runtime.js";
import { encryptionKey } from "./auth/security.js";
import { createDiagnostics, runtimeOrigin } from "@orvyn/shared/server";
import { SafeExceptionFilter } from "./diagnostics.js";
import {
  readRegistrationPolicy,
  RegistrationConfigurationError,
} from "./auth/registration.js";
import {
  initializeDeploymentOidc,
  DeploymentConfigurationError,
} from "./auth/deployment-oidc.js";
import { OidcModule } from "./oidc.module.js";
import { DatabaseTransferModule } from "./databases/transfer.module.js";
import { DatabasesModule } from "./databases.module.js";
import { FilesModule } from "./files.module.js";
import { storageHealth, attachments } from "./files/storage.js";
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
import { PublicationsModule } from "./publications/publications.module.js";
import { MarkdownImportsModule } from "./imports/markdown.module.js";
import { MarkdownExportsModule } from "./imports/markdown-export.module.js";
import { MarkdownBundlesModule } from "./imports/markdown-bundle.module.js";
import { WhiteboardsModule } from "./whiteboards.module.js";
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
    WhiteboardsModule,
    PublicationsModule,
    MarkdownImportsModule,
    MarkdownExportsModule,
    MarkdownBundlesModule,
  ],
})
class App {}
let log = createDiagnostics("api", {});
async function main() {
  log = createDiagnostics("api", process.env);
  await log.stage("configuration", async () => {
    runtimeOrigin(process.env);
    readRegistrationPolicy();
  });
  await log.stage("encryption", async () => {
    encryptionKey();
  });
  await log.stage("database", async () => {
    await db.query("SELECT 1");
  });
  await log.stage("migrations", () => migrate(db));
  await log.stage("oidc_configuration", () => initializeDeploymentOidc(db));
  await log.stage("storage", storageHealth);
  const app = await NestFactory.create(App, { logger: false });
  app.useGlobalFilters(new SafeExceptionFilter());
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    try {
      await app.close();
      attachments().close();
      await db.end();
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  app.use((req: any, res: any, next: any) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  await app.listen(Number(process.env.PORT || 3001), "0.0.0.0");
  console.log("ORVYN_READY " + (await app.getUrl()));
}
main().catch((error) => {
  log.error("startup.failed", { stage: "startup", error });
  process.exit(1);
});
