import {
  createDiagnostics,
  type ServerEnvironment,
} from "@orvyn/shared/server";
const write = (line: string) => {
  process.stderr.write(line + "\n");
};
export let log = createDiagnostics("collaboration", {}, write);
export function configureDiagnostics(env: ServerEnvironment) {
  log = createDiagnostics("collaboration", env, write);
  // Hocuspocus/ioredis use console for errors outside application hooks. Drop all
  // arbitrary strings, validation details and stacks before they reach stderr.
  const emit = (level: "warn" | "error", args: unknown[]) => {
    const error = args.find(
      (value) => value !== null && typeof value === "object",
    );
    log[level]("library." + level, {
      stage: "collaboration",
      error,
      ...(!error ? { code: "LIBRARY_EVENT" } : {}),
    });
  };
  console.error = (...args: unknown[]) => emit("error", args);
  console.warn = (...args: unknown[]) => emit("warn", args);
}
