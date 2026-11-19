import * as Y from "yjs";

export const whiteboardSchemaVersion = 1;
export const whiteboardElementLimit = 2000;
export const whiteboardByteLimit = 1024 * 1024;
export type WhiteboardElement = Record<string, any> & {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
};
export interface WhiteboardScene {
  elements: WhiteboardElement[];
  backgroundColor: string;
  gridSize: number | null;
}
const types = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "line",
  "arrow",
  "freedraw",
  "text",
  "image",
  "frame",
]);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const colorPattern =
  /^(?:transparent|#[a-fA-F0-9]{3,4}|#[a-fA-F0-9]{6}|#[a-fA-F0-9]{8})$/;
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function object(value: any) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function number(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function safeJson(value: any, depth = 0) {
  requireValue(depth <= 20, "Whiteboard structure is too deep");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    requireValue(value.length <= 80000, "Whiteboard text is too long");
    return;
  }
  if (typeof value === "number") {
    requireValue(
      Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
      "Invalid whiteboard number",
    );
    return;
  }
  if (Array.isArray(value)) {
    requireValue(value.length <= 20000, "Too many whiteboard points");
    for (const item of value) safeJson(item, depth + 1);
    return;
  }
  requireValue(
    object(value) && Object.keys(value).length <= 100,
    "Invalid whiteboard object",
  );
  for (const [key, item] of Object.entries(value)) {
    requireValue(
      !["__proto__", "constructor", "prototype"].includes(key) &&
        key.length <= 128,
      "Invalid whiteboard key",
    );
    safeJson(item, depth + 1);
  }
}
export function validWhiteboardLink(value: unknown) {
  if (value === null || value === "") return true;
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return false;
  try {
    const url = new URL(value, "https://orvyn.invalid");
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
  } catch {
    return false;
  }
}
export function validateWhiteboardScene(input: unknown): WhiteboardScene {
  requireValue(object(input), "Whiteboard scene required");
  const scene = input as WhiteboardScene;
  requireValue(
    new TextEncoder().encode(JSON.stringify(scene)).length <=
      whiteboardByteLimit,
    "Whiteboard size limit exceeded",
  );
  requireValue(
    Object.keys(scene).every((key) =>
      ["elements", "backgroundColor", "gridSize"].includes(key),
    ),
    "Unknown whiteboard setting",
  );
  requireValue(
    Array.isArray(scene.elements) &&
      scene.elements.length <= whiteboardElementLimit,
    "Whiteboard element limit exceeded",
  );
  requireValue(
    typeof scene.backgroundColor === "string" &&
      colorPattern.test(scene.backgroundColor),
    "Invalid whiteboard background",
  );
  requireValue(
    scene.gridSize === null ||
      (Number.isInteger(scene.gridSize) && number(scene.gridSize, 1, 100)),
    "Invalid whiteboard grid",
  );
  const ids = new Set<string>();
  for (const element of scene.elements) {
    requireValue(
      object(element) &&
        typeof element.id === "string" &&
        idPattern.test(element.id) &&
        !ids.has(element.id),
      "Invalid or duplicate whiteboard identity",
    );
    ids.add(element.id);
    requireValue(types.has(element.type), "Unsupported whiteboard element");
    safeJson(element);
    for (const key of ["x", "y", "width", "height"])
      requireValue(
        number(
          element[key],
          key === "x" || key === "y" ? -1000000 : 0,
          1000000,
        ),
        "Invalid whiteboard bounds",
      );
    requireValue(
      number(element.angle, -1000000, 1000000),
      "Invalid whiteboard angle",
    );
    requireValue(
      Number.isSafeInteger(element.version) &&
        element.version >= 1 &&
        Number.isSafeInteger(element.versionNonce),
      "Invalid whiteboard revision",
    );
    requireValue(
      typeof element.isDeleted === "boolean" &&
        typeof element.locked === "boolean",
      "Invalid whiteboard state",
    );
    requireValue(
      element.index === null ||
        (typeof element.index === "string" &&
          /^[A-Za-z0-9]{1,128}$/.test(element.index)),
      "Invalid whiteboard order",
    );
    requireValue(
      Array.isArray(element.groupIds) &&
        element.groupIds.length <= 64 &&
        element.groupIds.every(
          (id: unknown) => typeof id === "string" && idPattern.test(id),
        ),
      "Invalid whiteboard group",
    );
    requireValue(
      element.frameId === null ||
        (typeof element.frameId === "string" &&
          idPattern.test(element.frameId)),
      "Invalid whiteboard frame",
    );
    requireValue(
      colorPattern.test(element.strokeColor) &&
        colorPattern.test(element.backgroundColor),
      "Invalid whiteboard color",
    );
    requireValue(
      number(element.strokeWidth, 0, 100) &&
        number(element.roughness, 0, 10) &&
        number(element.opacity, 0, 100),
      "Invalid whiteboard style",
    );
    requireValue(validWhiteboardLink(element.link), "Invalid whiteboard link");
    if (element.type === "text") {
      requireValue(
        typeof element.text === "string" &&
          typeof element.originalText === "string" &&
          number(element.fontSize, 1, 1000) &&
          Number.isInteger(element.fontFamily) &&
          number(element.fontFamily, 1, 100),
        "Invalid whiteboard text",
      );
    }
    if (["line", "arrow", "freedraw"].includes(element.type)) {
      requireValue(
        Array.isArray(element.points) &&
          element.points.length <= 20000 &&
          element.points.every(
            (point: unknown) =>
              Array.isArray(point) &&
              point.length === 2 &&
              point.every((n) => number(n, -1000000, 1000000)),
          ),
        "Invalid whiteboard points",
      );
    }
    if (element.type === "image")
      requireValue(
        typeof element.fileId === "string" && uuidPattern.test(element.fileId),
        "Whiteboard image must finish uploading before it can be saved",
      );
  }
  return scene;
}
export function emptyWhiteboard(): WhiteboardScene {
  return { elements: [], backgroundColor: "#ffffff", gridSize: null };
}
export function whiteboardFiles(scene: WhiteboardScene) {
  return [
    ...new Set(
      scene.elements
        .filter((e) => e.type === "image")
        .map((e) => e.fileId as string),
    ),
  ];
}
export function whiteboardText(scene: WhiteboardScene) {
  return scene.elements
    .filter((e) => !e.isDeleted && e.type === "text")
    .map((e) => e.text)
    .join("\n")
    .slice(0, 80000);
}
export function whiteboardFromYDoc(document: Y.Doc) {
  requireValue(
    [...document.share.keys()].every((key) =>
      ["elements", "settings"].includes(key),
    ),
    "Unknown whiteboard document type",
  );
  const elements = document.getMap<WhiteboardElement>("elements"),
    settings = document.getMap("settings");
  requireValue(
    [...settings.keys()].every((key) =>
      ["backgroundColor", "gridSize"].includes(key),
    ),
    "Unknown whiteboard setting",
  );
  const values: WhiteboardElement[] = [];
  for (const [id, value] of elements) {
    requireValue(
      object(value) && value.id === id,
      "Whiteboard map identity mismatch",
    );
    values.push(value);
  }
  values.sort((a, b) =>
    a.index === b.index
      ? a.id < b.id
        ? -1
        : 1
      : (a.index || "") < (b.index || "")
        ? -1
        : 1,
  );
  return validateWhiteboardScene({
    elements: values,
    backgroundColor: settings.get("backgroundColor") ?? "#ffffff",
    gridSize: settings.get("gridSize") ?? null,
  });
}
export function whiteboardToYDoc(scene: WhiteboardScene) {
  validateWhiteboardScene(scene);
  const document = new Y.Doc();
  document.transact(() => {
    const elements = document.getMap<WhiteboardElement>("elements");
    for (const element of scene.elements) elements.set(element.id, element);
    const settings = document.getMap("settings");
    settings.set("backgroundColor", scene.backgroundColor);
    settings.set("gridSize", scene.gridSize);
  });
  return document;
}
