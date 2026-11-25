import type { Property, DatabaseRecord } from "@orvyn/shared";
export const propertyIcon = (p: Property) =>
  ({
    Title: "file",
    Text: "text",
    Number: "number",
    Select: "select",
    MultiSelect: "tags",
    Status: "select",
    Date: "calendar",
    Checkbox: "checklist",
    URL: "link",
    Email: "inbox",
    Phone: "text",
    Person: "users",
    Files: "paperclip",
    Relation: "link",
    Formula: "code",
    Rollup: "sum",
    CreatedTime: "clock",
    LastEditedTime: "history",
    CreatedBy: "users",
    LastEditedBy: "users",
  })[p.type] || "file";
export function formatDatabaseValue(
  record: DatabaseRecord,
  p: Property,
  people: { id: string; displayName: string }[] = [],
) {
  const value = record.values[p.id];
  if (value === null || value === undefined) return "";
  if (p.type === "CreatedBy")
    return record.createdBy?.displayName || "Former member";
  if (p.type === "LastEditedBy")
    return record.lastEditedBy?.displayName || "Former member";
  if (
    ["Number", "Formula", "Rollup"].includes(p.type) &&
    typeof value === "number"
  )
    return Intl.NumberFormat().format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (["Select", "Status"].includes(p.type))
    return p.config.options?.find((o) => o.id === value)?.label || "";
  if (Array.isArray(value))
    return value
      .map((id) =>
        p.type === "Relation"
          ? record.relations?.find((r) => r.id === id)?.title
          : p.type === "Files"
            ? record.files?.find((f) => f.id === id)?.filename
            : p.type === "Person"
              ? people.find((person) => person.id === id)?.displayName ||
                "Former member"
              : p.config.options?.find((o) => o.id === id)?.label,
      )
      .filter(Boolean)
      .join(", ");
  if (p.type.endsWith("Time")) return new Date(String(value)).toLocaleString();
  return String(value);
}
