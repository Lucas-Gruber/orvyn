import type { PoolClient } from "pg";
import {
  markdownBundleLimits as limits,
  type MarkdownBundleInput,
  type MarkdownBundleTree,
  type MarkdownBundlePreview,
} from "@orvyn/shared";
import { documentSchemaVersion } from "@orvyn/editor";
import {
  exportMarkdown,
  markdownHeadingAnchors,
  type MarkdownExportContext,
} from "@orvyn/editor/markdown-export";
import {
  documentAssets,
  documentReferences,
  pageLink,
  validHeadingId,
} from "@orvyn/editor/links";
import { documentPeople } from "@orvyn/editor/mentions";
import { readSnapshot, origin } from "../auth/security.js";
import { pageAccess } from "../permissions/access.js";
import { fail, hash } from "../runtime.js";
import {
  bundleSegment,
  uniqueSegment,
  bundleRelative,
} from "./markdown-bundle-paths.js";

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
function convert(document: unknown, context: MarkdownExportContext) {
  try {
    return exportMarkdown(document, context);
  } catch {
    return fail(
      400,
      "A selected page exceeds the Markdown conversion limits. Export a smaller selection.",
    );
  }
}
export async function bundleTree(
  c: PoolClient,
  actor: string,
  id: string,
): Promise<MarkdownBundleTree> {
  const root = await pageAccess(c, actor, id);
  if (!["page", "folder"].includes(root.kind))
    fail(400, "Choose a document or folder for a Markdown bundle.");
  await c.query("SET LOCAL statement_timeout='8s'");
  const rows = (
    await c.query(
      `WITH RECURSIVE tree AS (
    SELECT p.id,p.parent_id,p.title,p.kind,0 AS depth,ARRAY[p.sort_rank] AS ranks,ARRAY[p.id] AS ids
      FROM pages p WHERE p.id=$1
    UNION ALL
    SELECT p.id,p.parent_id,p.title,p.kind,t.depth+1,t.ranks||p.sort_rank,t.ids||p.id FROM pages p JOIN tree t ON p.parent_id=t.id
      WHERE t.depth<63 AND p.kind IN ('page','folder') AND orvyn_page_role(p.id,$2)>=10 AND NOT p.id=ANY(t.ids)
  ) SELECT id,parent_id AS "parentId",title,kind,depth FROM tree ORDER BY ranks,ids LIMIT $3`,
      [root.id, actor, limits.candidates + 1],
    )
  ).rows;
  if (rows[0]) rows[0].parentId = null;
  return {
    pages: rows.slice(0, limits.candidates),
    truncated: rows.length > limits.candidates,
  };
}

export async function bundlePlan(
  actor: string,
  id: string,
  input: MarkdownBundleInput,
) {
  return readSnapshot(async (c) => {
    const tree = await bundleTree(c, actor, id),
      root = tree.pages[0]!,
      candidates = new Map(tree.pages.map((page) => [page.id, page])),
      selected = new Set(input.pageIds);
    if (!selected.has(root.id))
      fail(400, "Keep the starting page in the export.");
    if (input.pageIds.some((page) => !candidates.has(page)))
      fail(
        404,
        "A selected page is unavailable in this hierarchy. Refresh the selection.",
      );
    const pages = (
        await c.query("SELECT * FROM pages WHERE id=ANY($1::uuid[])", [
          input.pageIds,
        ])
      ).rows,
      pageMap = new Map(pages.map((page) => [page.id, page])),
      paths = new Map<string, string>(),
      parents = new Map<string, string | null>(),
      siblingNames = new Map<string, Set<string>>();
    for (const page of tree.pages) {
      if (!selected.has(page.id)) continue;
      let parent = page.id === root.id ? null : page.parentId;
      while (parent && !selected.has(parent))
        parent = candidates.get(parent)?.parentId || null;
      const parentPath = parent ? paths.get(parent)!.slice(0, -9) : "";
      let used = siblingNames.get(parentPath);
      if (!used)
        siblingNames.set(parentPath, (used = new Set(["_attachments"])));
      const path =
        (parentPath ? parentPath + "/" : "") +
        uniqueSegment(page.title, used) +
        "/index.md";
      if (Buffer.byteLength(path) > 1800)
        fail(
          400,
          "The selected hierarchy is too deep for a portable archive. Choose fewer intermediate pages.",
        );
      paths.set(page.id, path);
      parents.set(page.id, parent);
    }
    const fileIds = new Set<string>(),
      relatedIds = new Set<string>();
    for (const page of pages) {
      if (page.document_schema_version > documentSchemaVersion)
        fail(409, "A page requires a newer application.");
      documentAssets(page.document).forEach((asset) =>
        fileIds.add(asset.fileId),
      );
      documentReferences(page.document, origin()).forEach((reference) =>
        relatedIds.add(reference.pageId),
      );
      function visit(node: any) {
        if (node.type === "orvynDatabase")
          relatedIds.add(node.attrs.databaseId);
        node.content?.forEach(visit);
      }
      visit(page.document);
    }
    const related = (
        await c.query(
          "SELECT id,title FROM pages WHERE id=ANY($1::uuid[]) AND orvyn_page_role(id,$2)>=10",
          [[...relatedIds], actor],
        )
      ).rows,
      relatedMap = new Map(related.map((page) => [page.id, page])),
      files = (
        await c.query(
          "SELECT id,page_id,object_key,filename,media_type,size FROM files WHERE id=ANY($1::uuid[]) AND state='ready' AND orvyn_page_role(page_id,$2)>=10 ORDER BY id",
          [[...fileIds], actor],
        )
      ).rows,
      fileMap = new Map(files.map((file) => [file.id, file])),
      filePaths = new Map<string, string>(),
      includedFiles = input.includeAttachments ? files : [];
    if (includedFiles.length > limits.files)
      fail(400, "Choose at most 100 embedded attachments in one bundle.");
    if (
      includedFiles.some(
        (file) =>
          !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0,
      ) ||
      includedFiles.reduce((sum, file) => sum + Number(file.size), 0) >
        limits.bytes
    )
      fail(400, "The selected attachments exceed the 32 MB bundle limit.");
    const fileNames = new Set<string>();
    for (const file of includedFiles)
      filePaths.set(
        file.id,
        paths.get(root.id)!.slice(0, -9) +
          "/_attachments/" +
          uniqueSegment(file.filename, fileNames, true),
      );
    const names = new Map<string, Map<string, string>>(),
      anchors = new Map<string, Map<string, string>>();
    for (const page of pages) {
      const people = input.includePeopleNames
        ? (
            await c.query(
              `SELECT u.id,u.email FROM users u JOIN spaces s ON s.id=$1
        WHERE u.id=ANY($2::uuid[]) AND (u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id)) AND orvyn_page_role($3,u.id)>=10`,
              [page.space_id, documentPeople(page.document), page.id],
            )
          ).rows
        : [];
      const current = new Map<string, string>(
        people.map((person) => [person.id, person.email]),
      );
      names.set(page.id, current);
      anchors.set(
        page.id,
        markdownHeadingAnchors(page.document, page.title, (person) =>
          current.get(person),
        ),
      );
    }
    const entries = new Map<string, string>(),
      pageDescriptions: MarkdownBundlePreview["pages"] = [];
    for (const [pageId, path] of paths) {
      const source = pageMap.get(pageId)!,
        result = convert(source.document, {
          title: source.title,
          pageUrl: new URL(pageLink(pageId), origin()).toString(),
          includePeopleNames: input.includePeopleNames,
          person: (person) => names.get(pageId)?.get(person),
          page: (targetId, headingId) => {
            const local = pageMap.get(targetId),
              foreign = relatedMap.get(targetId),
              heading = validHeadingId(headingId) ? headingId : "";
            if (local) {
              const anchor = heading
                ? anchors.get(targetId)?.get(heading)
                : undefined;
              return {
                title: local.title,
                href:
                  bundleRelative(path, paths.get(targetId)!) +
                  (anchor !== undefined
                    ? "#" + encodeURIComponent(anchor)
                    : ""),
                headingAvailable: !heading || anchor !== undefined,
              };
            }
            return foreign
              ? {
                  title: foreign.title,
                  href: new URL(
                    pageLink(targetId, heading),
                    origin(),
                  ).toString(),
                }
              : undefined;
          },
          file: (fileId, image) => {
            const file = fileMap.get(fileId),
              local = filePaths.get(fileId);
            return file && (!image || imageTypes.has(file.media_type))
              ? {
                  label: file.filename,
                  href: local
                    ? bundleRelative(path, local)
                    : new URL(
                        "/api/v1/files/" + file.id + "/download",
                        origin(),
                      ).toString(),
                  portable: !!local,
                }
              : undefined;
          },
        });
      const children = [...parents]
        .filter(([, parent]) => parent === pageId)
        .map(([child]) => ({
          path: bundleRelative(path, paths.get(child)!),
          title: pageMap.get(child)!.title,
        }));
      const label = (value: string) =>
        value
          .replace(/[\r\n\t]/g, " ")
          .replace(/[\\`*_[\]{}!#~|]/g, "\\$&")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const markdown =
        result.markdown +
        (children.length
          ? "\n---\n\n## Subpages\n\n" +
            children
              .map(
                (child) =>
                  "- [" + label(child.title) + "](<" + child.path + ">)",
              )
              .join("\n") +
            "\n"
          : "");
      entries.set(path, markdown);
      pageDescriptions.push({
        id: pageId,
        title: source.title,
        path,
        bytes: Buffer.byteLength(markdown),
        warnings: result.warnings,
      });
    }
    const warnings = [
      "This bundle contains the selected documents and folders, with added subpage navigation. Database data, whiteboard scenes, comments, history, permissions, icons and covers are not included.",
      "Links to pages outside the selection remain authenticated Orvyn links. No linked page is included automatically.",
    ];
    if (input.includeAttachments)
      warnings.push(
        "Copied attachments can be opened outside Orvyn. Only embedded, currently readable files are copied; other files remain excluded.",
      );
    if (tree.truncated)
      warnings.push(
        "The picker shows the first 500 readable pages. Choose a smaller section to export deeper pages.",
      );
    const publicFiles = includedFiles.map((file) => ({
        path: filePaths.get(file.id)!,
        filename: file.filename,
        bytes: Number(file.size),
      })),
      manifest = {
        format: "orvyn.markdown-bundle",
        version: 1,
        root: paths.get(root.id),
        pages: pageDescriptions.map(({ id, ...page }) => ({
          ...page,
          parent: parents.get(id) ? paths.get(parents.get(id)!) : null,
          kind: pageMap.get(id)!.kind,
        })),
        files: publicFiles,
        warnings,
      };
    entries.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    entries.set(
      "README.md",
      "# Orvyn Markdown export\n\nOpen `" +
        paths.get(root.id) +
        "` in a Markdown reader.\n\n" +
        warnings.map((warning) => "- " + warning).join("\n") +
        "\n\nSee manifest.json for the exported paths and conversion notes. This is a readable Markdown bundle, not a full backup or an automatic restore format.\n",
    );
    const bytes =
      [...entries.values()].reduce(
        (sum, text) => sum + Buffer.byteLength(text),
        0,
      ) + publicFiles.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > limits.bytes)
      fail(400, "The selected content exceeds the 32 MB bundle limit.");
    const filename = bundleSegment(root.title) + ".zip",
      digest = hash(
        JSON.stringify({
          entries: [...entries],
          files: includedFiles,
          input: { ...input, pageIds: [...input.pageIds].sort() },
          root: root.id,
        }),
      ),
      preview: MarkdownBundlePreview = {
        title: root.title,
        filename,
        digest,
        pages: pageDescriptions,
        files: publicFiles,
        bytes,
        warnings,
      };
    return {
      preview,
      entries,
      files: includedFiles.map((file) => ({
        ...file,
        path: filePaths.get(file.id)!,
      })),
    };
  });
}
