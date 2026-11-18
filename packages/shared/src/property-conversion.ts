// Reference/computed/selection fields need separate conversion rules; this
// initial path preserves scalar originals without resolving external data.
export const convertiblePropertyTypes = [
  "Text",
  "Number",
  "Date",
  "Checkbox",
  "URL",
  "Email",
  "Phone",
] as const;
export type ConvertiblePropertyType = (typeof convertiblePropertyTypes)[number];
