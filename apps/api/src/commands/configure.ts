import { db, migrate } from "../runtime.js";
import { encryptionKey } from "../auth/security.js";
import {
  configureDeploymentOidc,
  DeploymentConfigurationError,
} from "../auth/deployment-oidc.js";

async function main() {
  encryptionKey();
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      await db.query("SELECT 1");
      break;
    } catch {
      if (Date.now() >= deadline) throw Error("Database readiness timed out");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await migrate(db);
  await configureDeploymentOidc(db);
  console.log("ORVYN_CONFIGURATION_READY");
}
main()
  .catch((error) => {
    console.error(
      error instanceof DeploymentConfigurationError
        ? error.message
        : "Configuration failed; verify database, encryption and OIDC settings",
    );
    process.exitCode = 1;
  })
  .finally(() => db.end());
