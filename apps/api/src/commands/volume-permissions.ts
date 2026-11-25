import { runVolumePermissions } from "../volume-permissions.js";
import { createDiagnostics } from "@orvyn/shared/server";
runVolumePermissions(process.argv.slice(2)).catch((error) => {
  createDiagnostics("volume-permissions", {}).error(
    "permissions.command_failed",
    { stage: "volume_permissions", error },
  );
  process.exitCode = 1;
});
