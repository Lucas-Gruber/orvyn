import { Pool } from "pg";
import { writeFile, rm } from "node:fs/promises";
import { databaseConfiguration } from "@orvyn/auth";
import {
  createDiagnostics,
  runtimeOrigin,
  RuntimeConfigurationError,
} from "@orvyn/shared/server";
import { migrate } from "../migrations.js";
import {
  configurationInterval,
  configurationReadyPath,
  configurationAlivePath,
} from "../configuration-health.js";

let log = createDiagnostics("configuration", {}),
  pool: Pool | undefined;
let stopping = false,
  wake: (() => void) | undefined;
let applyingStage = "configuration";
const watch = process.argv.includes("--watch");
function stop() {
  stopping = true;
  wake?.();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
function pause(milliseconds: number) {
  if (stopping) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wake = finish;
  });
}
async function marker(path: string) {
  await writeFile(path, "ready\n", { mode: 0o600 });
}
async function main() {
  if (watch) {
    await rm(configurationReadyPath, { force: true });
    await rm(configurationAlivePath, { force: true });
  }
  log = createDiagnostics("configuration", process.env);
  await log.stage("configuration", async () => {
    if (process.argv.slice(2).some((arg) => arg !== "--watch"))
      throw new RuntimeConfigurationError(
        "CONFIGURATION_ARGUMENT_INVALID",
        "Use configure.js or configure.js --watch.",
      );
    runtimeOrigin(process.env);
    configurationInterval("reconcile");
    configurationInterval("retry");
    try {
      databaseConfiguration();
    } catch {
      throw new RuntimeConfigurationError(
        "DATABASE_CONFIGURATION_INVALID",
        "Configure PostgreSQL connection fields or DATABASE_URL.",
      );
    }
  });
  const { readDeploymentOidc, configureDeploymentOidc } =
    await import("../auth/deployment-oidc.js");
  applyingStage = "oidc_configuration";
  await log.stage("oidc_configuration", async () => {
    readDeploymentOidc();
  });
  const { encryptionKey } = await import("../auth/security.js");
  applyingStage = "encryption";
  await log.stage("encryption", async () => {
    encryptionKey();
  });
  applyingStage = "database";
  pool = new Pool({
    ...databaseConfiguration(),
    connectionTimeoutMillis: 5000,
    query_timeout: 120000,
  });
  pool.on("error", (error) =>
    log.error("database.connection_failed", { stage: "database", error }),
  );
  let initial = true;
  async function apply() {
    const stage = async (name: string, task: () => Promise<unknown>) => {
      applyingStage = name;
      return initial ? log.stage(name, task) : task();
    };
    await stage("database", async () => {
      await pool!.query("SELECT 1");
    });
    await stage("migrations", () => migrate(pool!));
    await stage("oidc_configuration", () => configureDeploymentOidc(pool!));
  }
  if (!watch) {
    const deadline = Date.now() + 120000;
    while (!stopping) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        log.debug("database.waiting", { stage: "database", error });
        await pause(1000);
      }
    }
    if (stopping) return;
    await apply();
    console.log("ORVYN_CONFIGURATION_READY");
    return;
  }
  while (!stopping) {
    await marker(configurationAlivePath);
    try {
      await apply();
      if (stopping) break;
      await marker(configurationReadyPath);
      if (initial)
        log.info("configuration.ready", { stage: "oidc_configuration" });
      else
        log.debug("configuration.reconciled", { stage: "oidc_configuration" });
      initial = false;
      await pause(configurationInterval("reconcile") * 1000);
    } catch (error) {
      await rm(configurationReadyPath, { force: true });
      log.error("configuration.retrying", {
        stage: applyingStage,
        error,
      });
      await pause(configurationInterval("retry") * 1000);
    }
  }
}
main()
  .catch((error) => {
    log.error("configuration.failed", { stage: applyingStage, error });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (watch) {
        await rm(configurationReadyPath, { force: true });
        await rm(configurationAlivePath, { force: true });
      }
      await pool?.end();
    } catch (error) {
      log.error("configuration.shutdown_failed", {
        stage: "configuration",
        error,
      });
      process.exitCode = 1;
    }
  });
