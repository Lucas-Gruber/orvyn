# Remaining product work

Work through these areas in order, preserving working features and committing/pushing tested functional changes. PRODUCT.md remains the complete specification; checked entries below describe implemented slices rather than completion of an entire product phase. Include current browser screenshots during substantial UI changes.

1. Editor and pages
   - [x] Slash commands, permanent document/heading links and backlinks.
   - [x] Callouts, collapsible sections, dynamic outlines and highlighted code.
   - [x] Private images/files embedded in document content.
   - [x] Internal document/heading preview cards.
   - [x] Opt-in YouTube/Vimeo/Loom video embeds.
   - [x] Two/three-column layouts and a floating selection formatting toolbar.
   - [x] Persistent column proportions with pointer/keyboard resizing, cancellation, collaboration and responsive stacking.
   - [x] Nested block selection and restructuring between columns, callouts, quotes, toggle bodies and the document.
   - [x] Whole document-block selection, movement, drag handles, duplication and deletion.
   - [x] Page/space emoji icons and preset covers; private image covers for pages.
   - [x] Folders, hierarchy dragging and keyboard reorder/nest/outdent.
   - [x] Empty-heading caret/level hints, icon/description slash menu, consistent modal spacing and discoverable keyboard shortcuts.
   - [x] Headings H1–H4 across Markdown, slash commands, formatting, shortcuts, outlines and permanent links.
   - [x] Clear editor tables with cell/row/column menus, resizing and unobtrusive empty cells.
   - [x] Pointer cursors for text links in both editable and read-only documents.
2. Collaboration
   - [x] Page discussion threads, replies, author editing, moderation and resolve/reopen.
   - [x] Text-anchored comments with relative positions and changed/deleted text handling.
   - [x] Discussion mentions and permission-filtered inbox for mentions/replies.
   - [x] Inline people mentions in documents with current identity resolution and inbox navigation.
   - [x] Page/space activity with current permission checks and private-record isolation.
3. Databases
   - [x] Same-space relations with permission-safe queries, exports and live target updates.
   - [x] Typed formulas with stable references, server-side queries/exports and a visual expression editor.
   - [x] Direct-relation rollups with scalar counts/numeric aggregates and permission-safe queries/exports.
   - [x] Database/record snapshot templates with authorized independent attachment copies.
   - [x] Side/center/full-page record opening, saved view preference and keyboard/context-menu actions.
   - [x] Table/board cell drafts survive failed writes, refresh and filtering; explicit retry/discard, same-field conflict review, queued edits and navigation/unload protection.
   - [x] Edit/delete/restore properties and selection options with stable IDs, retained record values, schema conflict checks and saved-view repair.
   - [x] Per-view property order/visibility with header drag, keyboard movement, export ordering and template ID remapping.
   - [x] Cross-space relations and direct rollups with independent target permissions, searchable database selection and live access refresh.
   - [x] Two-way relation properties with atomic mirror writes, independent record permissions, self-links and template/import support.
   - [x] Rollups across two relation steps, with independent permissions, consistent snapshots and live dependency refresh.
   - [x] Saved table column widths with pointer/keyboard resizing, cancellation, live readers, template remapping and conflict-safe view updates.
   - [x] Owner-reviewed scalar type conversion with signed snapshots, retained originals and restoration that preserves newer edits.
   - [ ] Additional conversion types, larger batches and type-history pagination.
   - [x] Read-only Kanban cards with first-image previews, scoped drag/drop, visible drop targets, keyboard/menu movement and retained failed-write drafts.
4. Search
   - [x] Indexed title/document full-text search with excerpts, space/type filters, ranked pagination and current access checks.
   - [x] Search stored scalar fields, option labels/tags and configured date/time metadata, with explicit scopes and matching-field previews.
   - [ ] Search computed/reference fields and identity metadata without copying actor-dependent or inaccessible content.
5. Whiteboards
   - [x] Excalidraw drawing/diagram editor with private images, durable element collaboration, standalone pages, direct document embedding, import/export and recovery checkpoints.
6. Sharing
   - [x] Explicit document/folder/whiteboard snapshot publication with scope preview and an isolated anonymous reader.
   - [x] Database saved-view, explicit record and visible-property publication scope, optional record bodies and five isolated public read-only views.
   - [x] Hierarchical public navigation with local search, breadcrumbs, a mobile picker and retained automatic/manual publication retries.
   - [x] Direct record-page publishing with independent property selection and no implicit parent database or sibling publication.
   - [x] Public formulas recomputed from explicitly shared inputs, with hidden inputs blocked and identity inputs explicitly named and no private graph reads.
   - [x] Public rollup aggregates over explicitly shared records/fields, including two steps and dependent formulas.
   - [x] Public people/creator/editor fields and mentions with explicit public names, root-scoped opaque IDs and alias-only formula/rollup dependencies.
   - [x] Revocable, expiring and optional password-protected links with current source checks and permanent revocation on source policy changes.
7. Localization, branding and administration
   - [ ] Runtime German/English/system language and synchronized preferences.
   - [ ] Instance/organization/space appearance, complete administration.
   - [ ] Identity linking, OIDC group mapping, real-provider validation and ownership transfer.
8. Import/export
   - [x] Single-page Markdown import with a complete preview, native editable blocks, permanent heading links, current destination checks and retry recovery.
   - [x] Reviewed Markdown document export with ordinary block conversion, optional current people names, protected reference/file links and fresh checked downloads.
   - [x] Bounded 96 KB UTF-8 Markdown file transport with pre-upload authorization, exact byte/Unicode checks and JSON compatibility.
   - [ ] Page hierarchies, attachment payloads and portable restore.
   - [ ] Faithful Notion import before claiming migration support.
9. Desktop and operation
   - [ ] Tauri clients, releases, update distribution and signing.
   - [ ] Kubernetes/Helm, observability, automated backup scheduling and production recovery.
   - [ ] Load testing, object-store deployment policies, accessibility and broader browser validation.
