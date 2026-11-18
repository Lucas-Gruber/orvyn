import type { ConvertiblePropertyType, Property } from "@orvyn/shared";
import { valueFor } from "./model.js";

export interface StoredPropertyCell {
  present: boolean;
  value: unknown;
}
export function emptyPropertyCell(cell: StoredPropertyCell) {
  return !cell.present || cell.value === null || cell.value === "";
}
export function samePropertyCell(a: StoredPropertyCell, b: StoredPropertyCell) {
  return (
    a.present === b.present &&
    (!a.present || JSON.stringify(a.value) === JSON.stringify(b.value))
  );
}
export function convertPropertyCell(
  source: StoredPropertyCell,
  property: Property,
  type: ConvertiblePropertyType,
): StoredPropertyCell {
  if (!source.present) return { present: false, value: null };
  if (source.value === null) return { present: true, value: null };
  const raw = source.value;
  let candidate: unknown = raw;
  if (type === "Number") {
    if (typeof raw === "string") {
      const value = raw.trim();
      candidate =
        value && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)
          ? Number(value)
          : null;
    } else if (typeof raw === "boolean") candidate = raw ? 1 : 0;
  } else if (type === "Checkbox") {
    if (typeof raw === "string") {
      const value = raw.trim().toLowerCase();
      candidate = ["true", "yes", "ja", "checked", "1"].includes(value)
        ? true
        : ["false", "no", "nein", "unchecked", "0"].includes(value)
          ? false
          : null;
    } else if (typeof raw === "number")
      candidate = raw === 1 ? true : raw === 0 ? false : null;
  } else if (type === "Date") {
    candidate = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } else {
    candidate = ["string", "number", "boolean"].includes(typeof raw)
      ? String(raw)
      : null;
    if (type !== "Text" && typeof candidate === "string")
      candidate = candidate.trim();
  }
  try {
    return {
      present: true,
      value: valueFor({ ...property, type, config: {} }, candidate),
    };
  } catch (error: any) {
    if (error.getStatus?.() === 400) return { present: true, value: null };
    throw error;
  }
}
