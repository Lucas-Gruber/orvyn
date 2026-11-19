import type { PoolClient } from "pg";
import {
  publicationLimits,
  type PublicationInput,
  type PublicationSnapshot,
  type PublicPage,
  type PublicFile,
} from "@orvyn/shared";
import { normalizeDocument, documentSchemaVersion } from "@orvyn/editor";
import {
  documentAssets,
  documentHeadings,
  validHeadingId,
} from "@orvyn/editor/links";
import {
  validateWhiteboardScene,
  whiteboardFiles,
} from "@orvyn/editor/whiteboards";
import { publicationDatabases } from "./databases.js";
import { publicWhiteboardElement } from "./whiteboard.js";
import { origin } from "../auth/security.js";
import { fail } from "../runtime.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const supportedKinds = new Set([
  "page",
  "folder",
  "whiteboard",
  "database",
  "record",
]);
const placeholder = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function publicHref(value: unknown, pages: Set<string>) {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const base = new URL(origin()),
      url = new URL(value, base);
    if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol))
      return undefined;
    if (
      url.origin === base.origin &&
      url.pathname === "/" &&
      url.searchParams.has("page")
    ) {
      const id = url.searchParams.get("page")!;
      if (!uuid.test(id) || !pages.has(id)) return undefined;
      const heading = url.hash.startsWith("#h-") ? url.hash.slice(3) : "";
      return "?page=" + id + (validHeadingId(heading) ? "#h-" + heading : "");
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function publicationSnapshot(
  c: PoolClient,
  actor: string,
  rootId: string,
  input: PublicationInput,
  write = false,
) {
  const selected = [
    ...new Set([
      rootId,
      ...input.scope.pageIds,
      ...input.scope.records.map((record) => record.recordId),
      ...input.scope.databases.map((item) => item.databaseId),
    ]),
  ];
  if (selected.length > publicationLimits.pages)
    fail(400, "Choose at most 100 pages");
  const sourceIds = new Set(selected);
  if (write) {
    const locations = await c.query(
      `SELECT space_id FROM pages WHERE id=ANY($1::uuid[]) AND orvyn_page_role(id,$2)>=40
      UNION SELECT p.space_id FROM files f JOIN pages p ON p.id=f.page_id WHERE f.id=ANY($3::uuid[]) AND f.state='ready' AND orvyn_page_role(p.id,$2)>=40`,
      [selected, actor, input.scope.extraFileIds],
    );
    const spaces = [
      ...new Set(locations.rows.map((row) => row.space_id)),
    ].sort();
    await c.query(
      "SELECT id FROM spaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [spaces],
    );
  }
  const pages = (
    await c.query(
      `SELECT p.*,orvyn_page_role(p.id,$2) AS access_rank FROM pages p
    WHERE p.id=ANY($1::uuid[]) AND orvyn_page_role(p.id,$2)>=40 ORDER BY p.id`,
      [selected, actor],
    )
  ).rows;
  if (pages.length !== selected.length)
    fail(404, "A selected page is unavailable or cannot be published");
  if (pages.some((page) => !supportedKinds.has(page.kind)))
    fail(400, "Choose supported pages for this publication");
  const root =
    pages.find((page) => page.id === rootId) || fail(404, "Page not found");
  const databases = await publicationDatabases(c, actor, input.scope);
  for (const id of databases.sourceIds) sourceIds.add(id);
  for (const page of pages) {
    if (page.kind === "database" && !databases.projections.has(page.id))
      fail(
        400,
        "Select a view, records and properties for each published database",
      );
    if (page.kind === "record" && !databases.recordOwners.has(page.id))
      fail(
        400,
        "Choose the properties for this record page or include it in a published database view",
      );
  }
  const rawDocuments = new Map<string, any>(),
    rawBoards = new Map<string, any>();
  const wantedFiles = new Set([
      ...input.scope.extraFileIds,
      ...databases.wantedFiles,
    ]),
    fileLabels = new Map<string, string>();
  for (const page of pages) {
    if (page.document_schema_version > documentSchemaVersion)
      fail(409, "A page requires a newer application");
    const document = normalizeDocument(page.document);
    const headings = documentHeadings(document);
    let headingIndex = 0;
    const anchor = (node: any) => {
      if (node.type === "heading")
        node.attrs = { ...node.attrs, id: headings[headingIndex++]!.id };
      for (const child of node.content || []) anchor(child);
    };
    anchor(document);
    rawDocuments.set(page.id, document);
    for (const reference of documentAssets(document))
      wantedFiles.add(reference.fileId);
    const labels = (node: any) => {
      if (node.type === "orvynFile" && node.attrs?.label)
        fileLabels.set(node.attrs.fileId, node.attrs.label);
      for (const child of node.content || []) labels(child);
    };
    labels(document);
    if (page.cover_file_id) wantedFiles.add(page.cover_file_id);
    if (page.kind === "whiteboard") {
      const row = (
        await c.query(
          "SELECT version,schema_version,scene FROM whiteboard_documents WHERE page_id=$1",
          [page.id],
        )
      ).rows[0];
      if (!row || row.schema_version !== 1)
        fail(409, "The whiteboard format is unavailable");
      const scene = validateWhiteboardScene(row.scene);
      const visible = validateWhiteboardScene({
        ...scene,
        elements: scene.elements
          .filter((element) => !element.isDeleted)
          .map(publicWhiteboardElement),
      });
      rawBoards.set(page.id, { version: row.version, scene: visible });
      for (const id of whiteboardFiles(visible)) wantedFiles.add(id);
    }
  }
  const extras = new Set(input.scope.extraFileIds);
  const files = (
    await c.query(
      `SELECT f.* FROM files f WHERE f.id=ANY($1::uuid[]) AND f.state='ready'
    AND orvyn_page_role(f.page_id,$2)>=40 AND (f.page_id=ANY($3::uuid[]) OR f.id=ANY($4::uuid[]) OR f.id=ANY($5::uuid[])) ORDER BY f.id`,
      [
        [...wantedFiles],
        actor,
        selected,
        input.scope.extraFileIds,
        [...databases.wantedFiles],
      ],
    )
  ).rows;
  const byFile = new Map(files.map((file) => [file.id, file]));
  for (const file of files)
    if (databases.fileFields.has(file.id))
      fileLabels.set(file.id, file.filename);
  for (const id of extras)
    if (!byFile.has(id))
      fail(404, "A selected attachment is unavailable or cannot be published");
  const usedFiles = new Set<string>(),
    publishedIds = new Set(selected),
    warnings = {
      excludedBlocks: 0,
      excludedFiles: 0,
      anonymousMentions: 0,
      excludedRelations: databases.omittedRelations,
    };
  function useFile(id: unknown, image = false) {
    if (typeof id !== "string") return false;
    const file = byFile.get(id);
    if (!file || (image && !imageTypes.has(file.media_type))) return false;
    usedFiles.add(id);
    sourceIds.add(file.page_id);
    return true;
  }
  function documentNode(node: any): any {
    if (node.type === "orvynPerson") {
      warnings.anonymousMentions++;
      return { type: "text", text: "@person" };
    }
    if (node.type === "orvynDatabase") {
      if (databases.projections.has(node.attrs?.databaseId))
        return {
          type: node.type,
          attrs: { databaseId: node.attrs.databaseId },
        };
      warnings.excludedBlocks++;
      return placeholder("Linked database not included");
    }
    if (node.type === "orvynWhiteboard" || node.type === "orvynPagePreview") {
      const target = pages.find((page) => page.id === node.attrs?.pageId);
      if (
        !target ||
        (node.type === "orvynWhiteboard" && target.kind !== "whiteboard")
      ) {
        warnings.excludedBlocks++;
        return placeholder("Linked content not included");
      }
    }
    if (node.type === "orvynImage" || node.type === "orvynFile") {
      if (!useFile(node.attrs?.fileId, node.type === "orvynImage")) {
        warnings.excludedFiles++;
        return placeholder(
          node.type === "orvynImage"
            ? "Image not included"
            : "Attachment not included",
        );
      }
    }
    const result = { ...node };
    if (result.marks)
      result.marks = result.marks.flatMap((mark: any) => {
        if (mark.type !== "link") return [mark];
        const href = publicHref(mark.attrs?.href, publishedIds);
        return href ? [{ type: "link", attrs: { href } }] : [];
      });
    if (result.content) result.content = result.content.map(documentNode);
    return result;
  }
  for (const projection of databases.projections.values())
    for (const record of projection.records)
      for (const property of projection.properties)
        if (property.type === "Files")
          record.values[property.id] = (
            record.values[property.id] as string[]
          ).filter((id) => useFile(id));
  for (const detail of databases.recordDetails.values())
    for (const property of detail.properties)
      if (property.type === "Files")
        detail.values[property.id] = (
          detail.values[property.id] as string[]
        ).filter((id) => useFile(id));
  const publicPages: PublicPage[] = pages.map((page) => {
    const board = rawBoards.get(page.id)?.scene;
    if (board)
      board.elements = board.elements
        .filter((element: any) => {
          if (element.type === "image" && !useFile(element.fileId, true)) {
            warnings.excludedFiles++;
            return false;
          }
          return true;
        })
        .map((element: any) => ({
          ...element,
          link: publicHref(element.link, publishedIds) || null,
        }));
    return {
      id: page.id,
      order: Number(page.sort_rank ?? page.sort_order ?? 0),
      title: page.title,
      kind: page.kind,
      parentId:
        page.id === rootId
          ? null
          : publishedIds.has(page.parent_id)
            ? page.parent_id
            : rootId,
      icon: page.icon || null,
      coverPreset: page.cover_preset || null,
      coverFileId: useFile(page.cover_file_id, true)
        ? page.cover_file_id
        : null,
      document: documentNode(rawDocuments.get(page.id)),
      ...(board ? { whiteboard: board } : {}),
      ...(databases.projections.has(page.id)
        ? { database: databases.projections.get(page.id)! }
        : {}),
      ...(page.kind === "record"
        ? {
            record: databases.recordDetails.get(page.id)!,
          }
        : {}),
    };
  });
  for (const id of extras) useFile(id);
  if (usedFiles.size > publicationLimits.files)
    fail(400, "Choose at most 250 attachments");
  const publishedFiles = files.filter((file) => usedFiles.has(file.id));
  if (
    publishedFiles.reduce((sum, file) => sum + Number(file.size), 0) >
    publicationLimits.attachmentBytes
  )
    fail(400, "Choose at most 100 MB of attachments");
  const fileMetadata: PublicFile[] = publishedFiles.map((file) => ({
    id: file.id,
    filename: extras.has(file.id)
      ? file.filename
      : fileLabels.get(file.id) ||
        `Image.${file.media_type.split("/")[1] || "bin"}`,
    mediaType: file.media_type,
    size: Number(file.size),
  }));
  const snapshot: PublicationSnapshot = {
    version: 1,
    rootId,
    pages: publicPages,
    files: fileMetadata,
    attachmentIds: [...extras].filter((id) => usedFiles.has(id)).sort(),
  };
  if (
    Buffer.byteLength(JSON.stringify(snapshot)) >
    publicationLimits.snapshotBytes
  )
    fail(400, "The publication is too large; choose fewer pages");
  return {
    root,
    snapshot,
    warnings,
    sourceIds: [...sourceIds].sort(),
    fileIds: [...usedFiles].sort(),
    fingerprint: {
      databases: databases.fingerprints,
      pages: pages.map((page) => [
        page.id,
        page.version,
        page.title_version,
        page.appearance_version,
        page.document_schema_version,
        rawBoards.get(page.id)?.version || null,
      ]),
      files: publishedFiles.map((file) => [
        file.id,
        file.page_id,
        file.state,
        file.object_key,
        file.size,
        file.media_type,
      ]),
    },
  };
}
