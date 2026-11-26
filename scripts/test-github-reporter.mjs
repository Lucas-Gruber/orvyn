import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { redactTestDiagnostics } from "./test-diagnostics.mjs";

const escape = (text) =>
  String(text)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
/** The spec log remains complete; this adds actionable, sanitized CI annotations. */
export default async function* githubFailures(source) {
  for await (const event of source) {
    if (event.type !== "test:fail" || event.data.todo || event.data.skip)
      continue;
    const data = event.data,
      error = data.details?.error;
    if (error?.failureType === "subtestsFailed") continue;
    const cause = error?.cause || error;
    const message = redactTestDiagnostics(
      (data.name || "Integration test") +
        "\n" +
        (cause?.message || error?.message || "Test failed; see full output."),
    ).slice(0, 5000);
    let attributes = "";
    try {
      const file = relative(
        process.cwd(),
        data.file?.startsWith("file:") ? fileURLToPath(data.file) : data.file,
      ).replaceAll("\\", "/");
      if (
        /^tests\/[a-z0-9_./-]+\.test\.mjs$/i.test(file) &&
        !file.split("/").includes("..")
      )
        attributes = ",file=" + file;
      if (attributes && Number.isSafeInteger(data.line) && data.line > 0)
        attributes += ",line=" + data.line;
      if (attributes && Number.isSafeInteger(data.column) && data.column > 0)
        attributes += ",col=" + data.column;
    } catch {}
    yield (
      "::error title=Integration test failed" +
      attributes +
      "::" +
      escape(message) +
      "\n"
    );
  }
}
