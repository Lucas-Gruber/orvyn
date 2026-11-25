import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeConfigurationError } from "@orvyn/shared/server";

export const configurationReadyPath = join(
  tmpdir(),
  "orvyn-configuration-ready",
);
export const configurationAlivePath = join(
  tmpdir(),
  "orvyn-configuration-alive",
);
export function configurationInterval(
  kind: "reconcile" | "retry",
  env = process.env,
) {
  const raw =
    env[
      kind === "reconcile"
        ? "ORVYN_CONFIGURATION_RECONCILE_SECONDS"
        : "ORVYN_CONFIGURATION_RETRY_SECONDS"
    ] || (kind === "reconcile" ? "30" : "5");
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 300)
    throw new RuntimeConfigurationError(
      "CONFIGURATION_INTERVAL_INVALID",
      "Configuration intervals must contain whole seconds between 1 and 300.",
    );
  return Number(raw);
}
export async function configurationHealthy(live = false, env = process.env) {
  try {
    const interval = configurationInterval("reconcile", env),
      retry = configurationInterval("retry", env);
    const maximum = live
      ? Math.max(180, Math.max(interval, retry) * 2 + 30)
      : Math.max(30, interval * 3 + 15);
    const file = await stat(
        live ? configurationAlivePath : configurationReadyPath,
      ),
      age = Date.now() - file.mtimeMs;
    return file.isFile() && age >= 0 && age <= maximum * 1000;
  } catch {
    return false;
  }
}
