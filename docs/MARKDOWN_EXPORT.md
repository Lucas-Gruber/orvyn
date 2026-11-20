# Markdown export

Open a document or record page and choose **Page actions → Export Markdown**. The dialog shows the exact saved file contents, conversion notes, copy/download actions and an optional **Include visible people names** switch. `Ctrl+Enter` / `⌘ Enter` downloads the reviewed file. Pending page edits are flushed before preparing it.

The export includes the current page title and document. It does not traverse child pages or include database record properties; CSV/JSON database exports remain separate. Basic text, inline formatting, H1–H4, lists/nested tasks, quotes, rules, tables and fenced code become Markdown. Own heading links become local Markdown fragments, so they rebind correctly when imported as another page. Foreign page/heading links retain authorized permanent Orvyn addresses. Linked page/database/whiteboard blocks become links without copying their contents.

Conversion notes explain expanded toggles, linearized columns, quoted callouts, a static outline, videos as links, unsupported underlining and table adjustments. Merged cells become an ordinary grid, headerless tables receive an empty Markdown header, and multiline cells become one readable line. Very wide tables use row lists. Code with backslashes before pipes in a table cell falls back to ordinary text to retain its characters; ordinary code pipes remain escaped GFM cells. Fenced code preserves literal backticks, entities and trailing blank lines. Line breaks in page titles use spaces.

People become `@person` unless names are explicitly enabled. Enabled names resolve only current members who can still read the source page; account addresses may be included, matching the authenticated mention UI. Raw person IDs, inaccessible identities and the member directory are not exported. File links resolve only ready attachments whose owning page the exporter can currently read. They remain authenticated Orvyn download URLs, not anonymous grants; attachment bytes require a separate transfer. Unavailable files and referenced pages use generic text without resolved private titles/filenames/identifiers.

The preview uses a repeatable read and returns a digest of the exact output/options. Download independently rechecks source/reference access and recomputes the file; a supplied review digest must still match or it returns 409. This avoids downloading a different file after a concurrent edit, target/access change or altered name selection. No durable export grant is created. An authorized programmatic download without a digest exports the current snapshot directly. Responses use private/no-store caching, safe UTF-8 attachment filenames and `text/markdown`.

Output is bounded to 1 MB; a note identifies files exceeding the current 96 KB single-file Markdown import limit. Complete hierarchy/attachment bundles, portable restoration and faithful Notion migration remain separate work. This export is an editable Markdown representation with reviewed conversions, not a full database/whiteboard/archive backup.

API (authenticated read access):

- `GET /api/v1/pages/:id/export/markdown?includePeopleNames=false`: `{title,filename,markdown,warnings,digest}`. Names default to false.
- `GET /api/v1/pages/:id/export.md?includePeopleNames=false&review=<digest>`: protected text attachment; `review` is optional for direct current-snapshot downloads.

`tests/markdown-export.test.mjs` covers native/Markdown round trips, code and table edge cases, structured-block notes, source and independent reference permissions, name opt-in, reviewed download freshness, protected attachment bytes, record-parent isolation and a Chromium concurrency/options/refresh/mobile/shortcut/download flow.
