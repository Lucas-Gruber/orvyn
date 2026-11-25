import {
  createDiagnostics,
  runtimeOrigin,
  runtimeUpstream,
} from "@orvyn/shared/server";

export default defineNitroPlugin(() => {
  let log = createDiagnostics("web", {});
  try {
    log = createDiagnostics("web", process.env);
    runtimeOrigin(process.env);
    runtimeUpstream(
      process.env,
      "NUXT_API_URL",
      ["http:", "https:"],
      "http://127.0.0.1:3001",
    );
    runtimeUpstream(
      process.env,
      "NUXT_COLLABORATION_UPSTREAM",
      ["ws:", "wss:"],
      "ws://127.0.0.1:3002",
    );
    log.info("startup.configuration_ready", { stage: "configuration" });
  } catch (error) {
    log.error("startup.configuration_failed", {
      stage: "configuration",
      error,
    });
    throw Error(
      "Web startup configuration is invalid; inspect the structured diagnostics.",
    );
  }
});
