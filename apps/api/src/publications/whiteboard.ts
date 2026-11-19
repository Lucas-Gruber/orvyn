import type { WhiteboardElement } from "@orvyn/editor/whiteboards";
const scalar = new Set([
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "frameId",
  "index",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "updated",
  "link",
  "locked",
  "fontSize",
  "fontFamily",
  "text",
  "textAlign",
  "verticalAlign",
  "containerId",
  "originalText",
  "autoResize",
  "lineHeight",
  "startArrowhead",
  "endArrowhead",
  "elbowed",
  "startIsSpecial",
  "endIsSpecial",
  "simulatePressure",
  "fileId",
  "status",
  "name",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const pair = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => typeof n === "number" && Number.isFinite(n))
    ? [...value]
    : undefined;
function numbers(value: unknown, keys: string[]) {
  if (!object(value)) return null;
  return Object.fromEntries(
    keys
      .filter(
        (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
      )
      .map((key) => [key, value[key]]),
  );
}
function binding(value: unknown) {
  if (!object(value) || typeof value.elementId !== "string") return null;
  return {
    elementId: value.elementId,
    ...numbers(value, ["focus", "gap"]),
    ...(pair(value.fixedPoint) ? { fixedPoint: pair(value.fixedPoint) } : {}),
  };
}
// Excalidraw permits application data alongside its native fields. Project
// nested native structures too, so metadata cannot ride through a known key.
export function publicWhiteboardElement(
  element: WhiteboardElement,
): WhiteboardElement {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element))
    if (
      scalar.has(key) &&
      (value === null || ["string", "number", "boolean"].includes(typeof value))
    )
      result[key] = value;
  result.groupIds = Array.isArray(element.groupIds)
    ? element.groupIds.filter((id) => typeof id === "string")
    : [];
  for (const key of ["scale", "lastCommittedPoint"])
    if (pair(element[key])) result[key] = pair(element[key]);
  if (Array.isArray(element.points))
    result.points = element.points.map(pair).filter(Boolean);
  if (Array.isArray(element.pressures))
    result.pressures = element.pressures.filter(
      (n) => typeof n === "number" && Number.isFinite(n),
    );
  if (Array.isArray(element.boundElements))
    result.boundElements = element.boundElements
      .filter(
        (value) =>
          object(value) &&
          typeof value.id === "string" &&
          ["arrow", "text"].includes(value.type as string),
      )
      .map((value) => ({ id: value.id, type: value.type }));
  else result.boundElements = null;
  for (const key of ["startBinding", "endBinding"])
    if (key in element) result[key] = binding(element[key]);
  if ("roundness" in element)
    result.roundness = numbers(element.roundness, ["type", "value"]);
  if ("crop" in element)
    result.crop = numbers(element.crop, [
      "x",
      "y",
      "width",
      "height",
      "naturalWidth",
      "naturalHeight",
    ]);
  if (Array.isArray(element.fixedSegments))
    result.fixedSegments = element.fixedSegments
      .filter(
        (value) =>
          object(value) &&
          typeof value.index === "number" &&
          pair(value.start) &&
          pair(value.end),
      )
      .map((value) => ({
        index: value.index,
        start: pair(value.start),
        end: pair(value.end),
      }));
  return result as WhiteboardElement;
}
