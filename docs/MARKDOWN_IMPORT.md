# Markdown import

The larger document budgets and connection-recovery fixes described here are included in version 0.3.1. Deploy the matching chart and all four application images after the tag-triggered release completes; the published 0.3.0 images retain the previous limits.

## Paste into an existing page

Paste plain-text Markdown directly into the document editor to create native editable headings, lists, tasks, tables, quotes, code and inline formatting. The first H1 stays in the document. Pasted headings get fresh identifiers on every paste; links to headings within the pasted Markdown point to those new identifiers. The whole paste supports undo/redo, normal saving and collaboration.

Use **Ctrl/Cmd+Shift+V** to keep the source literal. Code blocks always preserve literal text, and rich HTML clipboard content keeps its existing formatting. Conversion uses the same safe, bounded parser as file import; unsupported or oversized conversion falls back to plain text without discarding the clipboard content. Images remain text links and HTML remains visible text/code, as described below.

## Import a new page

Every sidebar **+** opens a choice of page, whiteboard, database or folder, plus Markdown import. The **+** beside an existing page keeps that destination for creation/import; the section-header and **New** menus create at the space root. Menus support arrow keys, Home/End, Escape and outside-click dismissal without creating anything.

Use **Create in this space → Import Markdown** for a top-level page, or **Page actions → Import Markdown as subpage** for the current page/folder. Choose a UTF-8 `.md`/`.markdown` file or paste Markdown, select the destination, optionally override the title, and preview the complete document before creating it. The first H1 can become the page title instead of being duplicated in the document.

The importer converts paragraphs, bold/italic/strikethrough/code, links, H1–H4, quotes, numbered/bullet/task lists, nested lists, fenced/indented code, horizontal rules and GFM tables to ordinary editable blocks. Headings retain stable identifiers. Markdown heading fragments resolve in the review and become permanent links to the new page’s headings after creation. Review navigation stays inside its own content, even when the underlying editor contains identical heading identifiers. Task markers become native checklist state.

The review lists adjustments: H5/H6 use H4, table alignment uses the editor default, unknown relative file/heading links become plain text, and HTML remains visible text/code. Images become text links rather than remote image embeds. Importing never fetches URLs, reads local files or grants access to attachments. Upload images/files separately after import. No scripts, HTML embeds, live people references or imported permissions are created from Markdown.

Limits: one page per import, 512 KB UTF-8 source, 2 MiB serialized document JSON, 20,000 document nodes, at most 64 document levels and 100,000 parser work units. Markdown conversion separately bounds nesting to 48 levels. The larger formatted-document budget accounts for the node/mark overhead of lists, tables and links. Page titles support 300 characters. Size, element-count and depth failures identify the actual limit without creating a partial page. Page hierarchies, attachment payloads, portable restoration and faithful Notion migration remain separate work.

The browser sends Markdown as a bounded multipart file, avoiding JSON escaping/CRLF transport overhead. Authorization and exact Origin checks run before the file interceptor. Uploads accept one file and one JSON `settings` field; the file is decoded strictly as UTF-8 in memory and never registered as an attachment. The shared 512 KB source limit counts UTF-8 bytes and accepts the exact boundary. Import, editor validation and collaboration use coordinated document budgets; binary editor state is bounded to 4 MiB and WebSocket messages/queues to 8 MiB. Whiteboard state keeps its separate 2 MiB limit. Invalid encoding, ambiguous settings, extra files/fields and invalid Unicode/NUL metadata are rejected before page creation. JSON clients remain supported within a bounded 4 MiB HTTP body. A file label comes from explicit UTF-8 metadata, preserving Unicode names independently of multipart filename encoding.

The signed review expires after ten minutes and binds the exact input, normalized content, actor, space and destination ancestry/membership/permissions. Confirmation rechecks current write access and the destination’s audience under the space lock. A changed policy requires another review even if the importer remains an owner. Creation writes the page, initial history, search/reference projections and an import receipt in one transaction. Migration 44 adds `page_import_requests`.

Retries use the same request ID and input, including after a lost response or review expiry when the page already exists. Concurrent confirmations return one page. A reused request ID with different input is rejected; a deleted result never creates a replacement silently. The UI retries a transient failure once and retains an uncertain review for manual retry.

API (authenticated, exact Origin):

- `POST /api/v1/spaces/:space/imports/markdown/preview`: `{filename,markdown,title?,titleFromHeading?,parentId?}` → title, normalized document, warnings, destination, preview token and a temporary review page ID.
- `POST /api/v1/spaces/:space/imports/markdown`: `{requestId,previewToken,input}` → created authorized page plus `replayed`. Self-heading links are rebound from the temporary review ID to the created page ID.

For multipart requests, use a `file` part and a JSON `settings` part. Preview settings contain `{filename,title?,titleFromHeading?,parentId?}`. Confirmation settings contain `{requestId,previewToken,input:{filename,title?,titleFromHeading?,parentId?}}`; source text comes only from the file. The browser uses multipart for selected files and pasted text, including exact retries. Existing JSON bodies below remain accepted within the HTTP JSON parser’s own size limit.

`tests/markdown-upload.test.mjs` covers transport overhead above the JSON request limit, exact/over-limit byte bounds, UTF-8/Unicode metadata, authorization before parsing, content/actor/policy binding, no-write failures and a Chromium large-file preview→import→reload flow.

`tests/markdown-import.test.mjs` covers conversion, stable links, current access and policy drift, idempotence/expiry, transactional rollback, URL/HTML isolation and a Chromium file→review→lost-response recovery→editable page→reload/mobile flow.
