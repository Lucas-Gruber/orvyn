import { configurationHealthy } from "../configuration-health.js";
process.exitCode = (await configurationHealthy(process.argv.includes("--live")))
  ? 0
  : 1;
