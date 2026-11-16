import * as Y from "yjs";
import {
  initProseMirrorDoc,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import { schema } from "./index.js";

export interface RelativePoint {
  type?: { client: number; clock: number };
  tname?: "default";
  item?: { client: number; clock: number };
  assoc?: number;
}
export interface CommentAnchor {
  from: RelativePoint;
  to: RelativePoint;
  quote: string;
}
function object(value: any): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function id(value: any) {
  return (
    object(value) &&
    Object.keys(value).every((k) => ["client", "clock"].includes(k)) &&
    Number.isSafeInteger(value.client) &&
    value.client >= 0 &&
    Number.isSafeInteger(value.clock) &&
    value.clock >= 0
  );
}
function point(value: any): value is RelativePoint {
  return (
    object(value) &&
    Object.keys(value).every((k) =>
      ["type", "tname", "item", "assoc"].includes(k),
    ) &&
    id(value.type) !== (value.tname === "default") &&
    (value.type === undefined || id(value.type)) &&
    (value.tname === undefined || value.tname === "default") &&
    (value.item === undefined || id(value.item)) &&
    (value.assoc === undefined || [-1, 0, 1].includes(value.assoc))
  );
}
export function validCommentAnchor(value: unknown): value is CommentAnchor {
  try {
    return (
      object(value) &&
      JSON.stringify(value).length <= 4096 &&
      Object.keys(value).every((k) => ["from", "to", "quote"].includes(k)) &&
      point(value.from) &&
      point(value.to) &&
      typeof value.quote === "string" &&
      !!value.quote.trim() &&
      value.quote.length <= 2000
    );
  } catch {
    return false;
  }
}
export function anchorForRange(
  ydoc: Y.Doc,
  from: number,
  to: number,
): CommentAnchor | null {
  const fragment = ydoc.getXmlFragment("default"),
    { doc, mapping } = initProseMirrorDoc(fragment, schema);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to > doc.content.size
  )
    return null;
  const quote = doc.textBetween(from, to, "\n");
  if (!quote.trim() || quote.length > 2000) return null;
  const anchor = {
    from: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(from, fragment, mapping),
    ),
    to: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(to, fragment, mapping),
    ),
    quote,
  };
  return validCommentAnchor(anchor) ? anchor : null;
}
export function commentAnchorResolver(ydoc: Y.Doc) {
  const fragment = ydoc.getXmlFragment("default"),
    { doc, mapping } = initProseMirrorDoc(fragment, schema);
  return (anchor: unknown) => {
    if (!validCommentAnchor(anchor)) return null;
    try {
      const from = relativePositionToAbsolutePosition(
          ydoc,
          fragment,
          Y.createRelativePositionFromJSON(anchor.from),
          mapping,
        ),
        to = relativePositionToAbsolutePosition(
          ydoc,
          fragment,
          Y.createRelativePositionFromJSON(anchor.to),
          mapping,
        );
      if (
        from === null ||
        to === null ||
        from < 0 ||
        to <= from ||
        to > doc.content.size
      )
        return null;
      const quote = doc.textBetween(from, to, "\n");
      if (!quote.trim()) return null;
      return { from, to, quote, changed: quote !== anchor.quote };
    } catch {
      return null;
    }
  };
}
export function resolveCommentAnchor(ydoc: Y.Doc, anchor: unknown) {
  return commentAnchorResolver(ydoc)(anchor);
}
export function resolveStoredCommentAnchor(state: Uint8Array, anchor: unknown) {
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, state);
    return resolveCommentAnchor(ydoc, anchor);
  } catch {
    return null;
  } finally {
    ydoc.destroy();
  }
}
