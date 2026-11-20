import { posix } from "node:path";

// Segments are authored titles, never archive paths or source identifiers.
export function bundleSegment(value: string) {
  let name = [...value.normalize("NFC")]
    .filter(
      (character) =>
        !/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(character),
    )
    .join("")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  name = [...name]
    .slice(0, 48)
    .join("")
    .replace(/[. ]+$/g, "");
  if (
    !name ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i.test(name)
  )
    name = "_" + (name || "page");
  return name;
}
export function uniqueSegment(
  title: string,
  used: Set<string>,
  keepExtension = false,
) {
  let base = bundleSegment(title);
  const extension = keepExtension
    ? title.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0] || ""
    : "";
  if (extension && !base.endsWith(extension))
    base =
      [...base]
        .slice(0, 48 - extension.length)
        .join("")
        .replace(/[. ]+$/g, "") + extension;
  const stem = extension ? base.slice(0, -extension.length) : base;
  let candidate = base,
    index = 1;
  while (used.has(candidate.toUpperCase().normalize("NFC")))
    candidate = stem + " - " + ++index + extension;
  used.add(candidate.toUpperCase().normalize("NFC"));
  return candidate;
}
export function bundleRelative(from: string, target: string) {
  return posix
    .relative(posix.dirname(from), target)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
