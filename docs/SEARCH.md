# Workspace full-text search

Open **Search** in the sidebar, `Ctrl/Cmd P`, or `Ctrl/Cmd K` outside the editor. The default searches page titles and saved document text across the signed-in user's authorized spaces. Controls filter by space, page/folder/database/record type or titles only. Record document bodies participate; structured database property values do not yet participate.

Queries use PostgreSQL's `simple` text configuration with an AND of word prefixes. Matching is case-insensitive, preserves accents and supports German/English text without imposing one language's stemming rules. All query terms must occur in the indexed title/document, or the title must contain the complete literal query. Exact titles precede other title matches, followed by body matches; weighted full-text rank and current modification time break ties. Percent/underscore characters in title searches are literal. Phrase operators, fuzzy matching and language-specific stemming are not implemented.

Results contain bounded, plain-text excerpts and character ranges for highlighting. The browser renders those ranges as escaped text, never HTML. Markup typed into a code block remains literal. The query uses server-side cursor pagination after authorization, so hidden pages neither fill a page nor contribute to a reported total. The UI shows one page of up to 30 results, supports keyboard navigation and does not fetch entire documents for its previews. Its open results refresh every five seconds and on focus/visibility return; closing/sign-out clears component state. Requests for older query/filter/cursor states are canceled and ignored. Clicking a result still opens the page through the normal access checks and pending-write navigation flow.

## Projection and migration

Migration 34 creates a separate `page_search` projection with GIN full-text and trigram title indexes. PostgreSQL must provide the standard trusted `pg_trgm` extension; the repository's PostgreSQL container includes it. The migration backfills existing documents by inserting into the projection, preserving page/revision content, versions and modification timestamps.

An insert or title/document update on `pages` updates the projection in the same transaction. REST writes, collaborative durable writes, template application and title edits therefore share the same index path. Unacknowledged/offline edits are not searched. Source document sizes/structure are bounded by the editor schema; the index includes the complete permitted text rather than a truncated prefix.

Extraction reads authored `text` and `content` nodes, joins adjacent formatting spans and separates blocks. It does not resolve node attributes, people, attachments, dynamic document previews or linked databases into copied content. Source snippets never inherit the contents of an inaccessible referenced page. The projection is an internal table, not additional columns serialized by existing page APIs. Trash retains its projection for restoration; every read checks current access, including ancestor trash/restrictions and current space membership.

## API

`GET /api/v1/search` continues to return an array of page metadata, adding `match_source`, `excerpt` and `highlights`. Optional parameters are `q` (up to 200 characters), `spaceId`, `kind`, `scope=all|title`, `limit` (1–100, default 40) and `after`. A next page is advertised only through `X-Next-Cursor`; there is no hidden/global result count. Cursors retain exact PostgreSQL microsecond timestamps and are bound to the query/filter state. Each page is evaluated against current permissions. Results are mutable as documents or permissions change, rather than a frozen search snapshot. Responses use `Cache-Control: private, no-store`.

Document/heading link pickers explicitly use `scope=title`, preserving their previous title-focused behavior. The document search endpoint does not search binary attachment contents, comments, tags, arbitrary property values or historical revisions. Those are separate remaining work.

## Verification

`tests/fulltext-search.test.mjs` checks complete saved-content indexing, formatting-span joins, prefix/multiple-term/Unicode searches, ranking, current ACLs and inherited restrictions, preview/attribute exclusion, edit/rename/trash/restore updates, space/type/title filtering, cursor binding and microsecond ties, literal punctuation, GIN index availability, safe highlighted excerpts and real browser navigation, pagination, cancellation, access refresh, failures and mobile geometry. `tests/migrations.test.mjs` checks legacy backfill without touching existing page versions/timestamps. Existing search, linking, workspace and cell-draft tests remain part of the suite.
