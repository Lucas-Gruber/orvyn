import { databaseConfiguration } from "@orvyn/auth";
import {
  createDiagnostics,
  runtimeOrigin,
  RuntimeConfigurationError,
} from "@orvyn/shared/server";

/** Validate before loading modules which construct clients at module scope. */
export async function startApplication(
  component: "api" | "worker",
  load: () => Promise<{ main: () => Promise<void> }>,
) {
  let log = createDiagnostics(component, {});
  let stage = "configuration";
  const fatal = (error: unknown) => {
    log.error("process.failed", { stage: "runtime", error });
    process.exit(1);
  };
  process.once("uncaughtException", fatal);
  process.once("unhandledRejection", fatal);
  try {
    log = createDiagnostics(component, process.env);
    runtimeOrigin(process.env);
    try {
      databaseConfiguration();
    } catch {
      throw new RuntimeConfigurationError(
        "DATABASE_CONFIGURATION_INVALID",
        "Configure a valid PostgreSQL connection.",
      );
    }
    stage = "startup";
    await (await load()).main();
  } catch (error) {
    log.error("startup.failed", { stage, error });
    process.exit(1);
  }
}
