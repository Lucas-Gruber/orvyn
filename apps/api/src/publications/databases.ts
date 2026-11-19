import type { PoolClient } from "pg";
import {
  type PublicationScope,
  type PublicDatabase,
  type PublicProperty,
  type PublicValue,
  orderedViewProperties,
  queryInput,
} from "@orvyn/shared";
import {
  database,
  checkedView,
  querySql,
  valueFor,
} from "../databases/model.js";
import { fail } from "../runtime.js";

// Public values are a deliberate projection. Identity and calculated fields
// need their own public dependency model before they can be selected here.
export const publicPropertyTypes = new Set([
  "Title",
  "Text",
  "Number",
  "Select",
  "MultiSelect",
  "Status",
  "Date",
  "Checkbox",
  "URL",
  "Email",
  "Phone",
  "Files",
  "Relation",
  "CreatedTime",
  "LastEditedTime",
]);
export function publicViewProperties(
  context: Awaited<ReturnType<typeof database>>,
  view: any,
) {
  const config = checkedView(context.properties, view.type, view.config);
  const visible = orderedViewProperties(context.properties, config);
  const structural = new Set([config.groupBy, config.dateProperty]);
  return {
    config,
    properties: context.properties
      .filter(
        (p) =>
          p.type === "Title" ||
          structural.has(p.id) ||
          visible.some((v) => v.id === p.id),
      )
      .sort((a, b) => {
        const position = (id: string) => {
          const index = visible.findIndex((p) => p.id === id);
          return index < 0 ? 1000 : index;
        };
        return position(a.id) - position(b.id) || a.position - b.position;
      }),
  };
}
export async function publicationDatabases(
  c: PoolClient,
  actor: string,
  scope: PublicationScope,
) {
  const selectedRecords = new Set([
    ...scope.databases.flatMap((item) => item.recordIds),
    ...scope.records.map((item) => item.recordId),
  ]);
  const projections = new Map<string, PublicDatabase>(),
    sourceIds = new Set<string>(),
    fingerprints: unknown[] = [],
    recordOwners = new Map<string, string>(),
    wantedFiles = new Set<string>();
  const recordsById = new Map<string, any>(),
    recordProperties = new Map<string, PublicProperty[]>(),
    fileFields = new Set<string>();
  const recordDetails = new Map<
    string,
    { properties: PublicProperty[]; values: Record<string, PublicValue> }
  >();
  const choices = scope.databases.map((choice) => ({
    ...choice,
    direct: false,
  }));
  for (const record of scope.records) {
    const source = (
      await c.query(
        "SELECT r.database_id FROM database_records r JOIN pages p ON p.id=r.page_id WHERE p.id=$1 AND orvyn_page_role(p.id,$2)>=40",
        [record.recordId, actor],
      )
    ).rows[0];
    if (!source)
      fail(404, "A selected record page is unavailable or cannot be published");
    choices.push({
      databaseId: source.database_id,
      viewId: "",
      recordIds: [record.recordId],
      propertyIds: record.propertyIds,
      direct: true,
    });
  }
  const catalogs = new Map<string, Awaited<ReturnType<typeof database>>>();
  let omittedRelations = 0;
  for (const choice of choices) {
    let context = catalogs.get(choice.databaseId);
    if (!context) {
      context = await database(c, actor, choice.databaseId, 40);
      catalogs.set(choice.databaseId, context);
    }
    const view = choice.direct
      ? {
          name: "Record properties",
          type: "List",
          id: undefined,
          version: 0,
          config: {
            filters: [],
            sorts: [],
            visibleProperties: choice.propertyIds,
            groupBy: null,
            dateProperty: null,
          },
        }
      : context.views.find((item) => item.id === choice.viewId) ||
        fail(404, "A selected database view is unavailable");
    const { config, properties: visible } = publicViewProperties(context, view);
    const title =
      context.properties.find((property) => property.type === "Title") ||
      fail(409, "The title property is unavailable");
    if (!choice.propertyIds.includes(title.id))
      fail(400, "Include the title property in the public view");
    const properties = choice.propertyIds.map(
      (id) =>
        visible.find((property) => property.id === id) ||
        fail(400, "Only visible properties can be published"),
    );
    if (properties.some((property) => !publicPropertyTypes.has(property.type)))
      fail(400, "Identity and calculated properties cannot be published yet");
    for (const id of [
      view.type === "Board" ? config.groupBy : null,
      view.type === "Calendar" ? config.dateProperty : null,
    ])
      if (id && !choice.propertyIds.includes(id))
        fail(
          400,
          "Include the grouping or date property used by this public view",
        );
    const ordered = visible.filter((property) =>
      choice.propertyIds.includes(property.id),
    );
    const query = querySql(
      context.properties,
      config,
      queryInput.parse({ viewId: view.id, limit: 200 }),
      actor,
      context.page.id,
      [],
      { recordIds: choice.recordIds, minRank: 40, identitiesOnly: true },
    );
    const ids: string[] = [];
    for (let offset = 0; offset < choice.recordIds.length; offset += 200) {
      const pageQuery =
        offset === 0
          ? query
          : querySql(
              context.properties,
              config,
              queryInput.parse({ viewId: view.id, limit: 200, offset }),
              actor,
              context.page.id,
              [],
              {
                recordIds: choice.recordIds,
                minRank: 40,
                identitiesOnly: true,
              },
            );
      const rows = (await c.query(pageQuery.sql, pageQuery.params)).rows;
      ids.push(...rows.slice(0, 200).map((row) => row.id));
    }
    if (
      ids.length !== choice.recordIds.length ||
      new Set(ids).size !== choice.recordIds.length
    )
      fail(
        409,
        "Some selected records are unavailable or no longer match the view. Review the record selection.",
      );
    const rows = (
      await c.query(
        `SELECT p.id,p.title,p.version AS page_version,p.title_version,p.appearance_version,p.document_schema_version,p.created_at,p.updated_at,r.version,r.values
   FROM database_records r JOIN pages p ON p.id=r.page_id WHERE r.database_id=$1 AND p.id=ANY($2::uuid[]) AND orvyn_page_role(p.id,$3)>=40`,
        [context.page.id, ids, actor],
      )
    ).rows;
    if (rows.length !== ids.length)
      fail(409, "Selected records changed. Review them again.");
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const fieldFileIds = [
      ...new Set(
        rows.flatMap((row) =>
          ordered
            .filter((p) => p.type === "Files")
            .flatMap((p) =>
              Array.isArray(row.values[p.id]) ? row.values[p.id] : [],
            ),
        ),
      ),
    ];
    const ready = (
      await c.query(
        "SELECT id,page_id FROM files WHERE id=ANY($1::uuid[]) AND state='ready'",
        [fieldFileIds],
      )
    ).rows;
    const owned = new Map(ready.map((file) => [file.id, file.page_id]));
    const records = ids.map((id) => {
      const row = rowMap.get(id)!;
      sourceIds.add(id);
      recordOwners.set(id, context.page.id);
      recordsById.set(id, row);
      const values: Record<string, PublicValue> = {};
      for (const property of ordered) {
        const raw = row.values[property.id];
        let value: PublicValue;
        switch (property.type) {
          case "Title":
            value = row.title;
            break;
          case "CreatedTime":
            value = new Date(row.created_at).toISOString();
            break;
          case "LastEditedTime":
            value = new Date(row.updated_at).toISOString();
            break;
          case "Relation": {
            const references = Array.isArray(raw) ? raw : [];
            value = references.filter((target: string) =>
              selectedRecords.has(target),
            );
            omittedRelations += references.length - value.length;
            break;
          }
          case "Files": {
            value = (Array.isArray(raw) ? raw : []).filter(
              (file: string) => owned.get(file) === id,
            );
            for (const file of value as string[]) {
              wantedFiles.add(file);
              fileFields.add(file);
            }
            break;
          }
          case "Select":
          case "Status":
            value =
              typeof raw === "string" &&
              property.config.options?.some((option) => option.id === raw)
                ? raw
                : null;
            break;
          case "MultiSelect":
            value = (Array.isArray(raw) ? raw : []).filter((id: string) =>
              property.config.options?.some((option) => option.id === id),
            );
            break;
          default:
            value = valueFor(property, raw ?? null) as PublicValue;
        }
        values[property.id] = value;
      }
      return { pageId: id, title: row.title, values };
    });
    const publicProperties: PublicProperty[] = ordered.map((property) => {
      const options = property.config.options?.filter((option) =>
        records.some((record) => {
          const value = record.values[property.id];
          return (
            value === option.id ||
            (Array.isArray(value) && value.includes(option.id))
          );
        }),
      );
      return {
        id: property.id,
        name: property.name,
        type: property.type,
        ...(options
          ? {
              options: options.map(({ id, label, color }) => ({
                id,
                label,
                color,
              })),
            }
          : {}),
      };
    });
    for (const id of ids) recordProperties.set(id, publicProperties);
    for (const record of records)
      recordDetails.set(record.pageId, {
        properties: publicProperties,
        values: record.values,
      });
    const projected: PublicDatabase = {
      properties: publicProperties,
      records,
      view: {
        name: view.name,
        type: view.type,
        ...(view.type === "Board" && config.groupBy
          ? { groupBy: config.groupBy }
          : {}),
        ...(view.type === "Calendar" && config.dateProperty
          ? { dateProperty: config.dateProperty }
          : {}),
        propertyWidths: Object.fromEntries(
          Object.entries(config.propertyWidths || {}).filter(([id]) =>
            choice.propertyIds.includes(id),
          ),
        ),
      },
    };
    if (!choice.direct) projections.set(context.page.id, projected);
    sourceIds.add(context.page.id);
    fingerprints.push([
      context.page.id,
      context.schemaVersion,
      view.id,
      view.version,
      rows
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((row) => [
          row.id,
          row.version,
          row.page_version,
          row.title_version,
          row.appearance_version,
          row.document_schema_version,
        ]),
    ]);
  }
  return {
    projections,
    sourceIds,
    fingerprints,
    recordsById,
    recordProperties,
    recordDetails,
    recordOwners,
    wantedFiles,
    fileFields,
    omittedRelations,
  };
}
