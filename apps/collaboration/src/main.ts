import { databaseConfiguration } from "@orvyn/auth";
import { runtimeOrigin, RuntimeConfigurationError } from "@orvyn/shared/server";
import { configureDiagnostics, log } from "./diagnostics.js";
async function start() {
  let stage = "configuration";
  const fatal = (error: unknown) => {
    log.error("process.failed", { stage: "runtime", error });
    process.exit(1);
  };
  process.once("uncaughtException", fatal);
  process.once("unhandledRejection", fatal);
  try {
    configureDiagnostics(process.env);
    runtimeOrigin(process.env);
    try {
      databaseConfiguration();
    } catch {
      throw new RuntimeConfigurationError(
        "DATABASE_CONFIGURATION_INVALID",
        "Configure a valid PostgreSQL connection.",
      );
    }
    try {
      if (process.env.REDIS_URL) {
        const url = new URL(process.env.REDIS_URL);
        if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname)
          throw Error();
      } else {
        if (process.env.NODE_ENV === "production" && !process.env.VALKEY_HOST)
          throw Error();
        const port = Number(process.env.VALKEY_PORT || 6379);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error();
      }
    } catch {
      throw new RuntimeConfigurationError(
        "VALKEY_CONFIGURATION_INVALID",
        "Configure a valid Redis URL or Valkey host and port.",
      );
    }
    stage = "startup";
    await (await import("./server.js")).main();
  } catch (error) {
    log.error("startup.failed", { stage, error });
    process.exit(1);
  }
}
void start();
