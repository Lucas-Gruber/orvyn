# Structured databases

## ADR 005: Record-pages with shared authorization

A database is a regular page of kind database. A record is a regular page of kind record with a database_records row; its parent is its database page. A composite foreign key enforces that association. Record pages support the existing editor, Yjs state, attachments, subpages, permissions, trash and history. Generic moves cannot remove a record from its database. Database moves preserve their prior audience through the existing page policy.

Database properties and views have their own tables. Record values use validated JSONB keyed by stable property UUID, with database and JSONB indexes. Schema/property IDs and API contracts are shared between web and backend in @orvyn/shared using Zod 4.6.7 (MIT). Adding or renaming properties does not rename record value keys.

Working property types: Title (managed by the page), Text, Number, Select, MultiSelect, Status, Date, Checkbox, URL, Email, Phone, Person, Files, CreatedTime, CreatedBy, LastEditedTime and LastEditedBy. Metadata is read-only. Date values are canonical ISO dates; metadata timestamps are UTC ISO instants. Legacy page timestamps/actors are backfilled from the first/last known content revisions, falling back to the space owner and migration time where older evidence is absent.

Relation, Formula and Rollup are implemented; see DATABASE_RELATIONS.md, DATABASE_FORMULAS.md and DATABASE_ROLLUPS.md for their supported scope. Database/record snapshot templates are described in DATABASE_TEMPLATES.md. Portable JSON restore is not implemented yet.

## Property management

Editors open **Properties** in the database menu or click a property header. Names and selection options are edited explicitly and saved against the current database schema revision; a stale editor keeps its draft and offers the saved property for review. Option IDs remain stable when labels, colors or order change. Removing an option requires explicit confirmation because saved filters using it are removed. Deleted options can be restored through the same editor with their original IDs.

Properties are soft-deleted, retaining their type, IDs and record values. Title cannot be deleted. Active formulas/local rollups that require a property must be updated or deleted first. Deletion removes its view filters, sorting and column/group/date references; boards/calendars that require it become tables. Restore reactivates the original property and values without overwriting subsequent view settings. Relation indexes are rebuilt on restoration and still resolve only currently readable targets. Deleted properties/options require current editor access, and mutations use the same page lock and optimistic schema revision as other schema changes.

Migration 33 adds a separate archive for deleted selection options. Active metadata excludes that archive. Removed option IDs remain in stored record values for restoration but are projected as empty/absent in record reads, formulas, filters and exports. Restoring an option reactivates those references. Schema changes notify live views. Property types remain immutable. Saved views support independent column ordering and visibility through the view-bar Properties control and table header grips; see DATABASE_VIEW_LAYOUT.md. Property type conversion and column resizing remain unfinished.

Property recovery remains available while cell drafts are unresolved, allowing an externally deleted property or option to be restored before retrying the cell. Destructive schema changes wait for pending drafts. `tests/database-properties.test.mjs` covers stable option identity, archives, retained values, selection filtering/exports, schema conflicts, formula/rollup dependencies, view conversion, role checks, relation restoration and real browser management including mobile geometry and pending cell-draft recovery.

## Views and editing

Table, Board, List, Calendar and Gallery use the same records. Saved views retain filters, sorts, selected properties, grouping and calendar date property. Title opens a side peek, center modal or full record page according to the saved view preference and explicit row action. A view's group/date property is also projected when needed to render it. Timeline is not implemented.

Queries filter each record through orvyn_page_role before ordering or pagination. Search, property filters and sorts execute on PostgreSQL. Values are type-checked before persistence; property types are immutable in the current API. Filters are parameterized and operators/directions are allowlisted. A view query returns only its selected properties plus the fields needed to render that view; view column visibility is a presentation rule, not an independent property-level ACL.

Results paginate at 100 records by default, maximum 200, with explicit offsets and nextOffset. Board counts refer to the current loaded page. Deep-offset performance, very large datasets and field-specific index tuning have not been benchmarked.

Property cells save through optimistic record revisions. Active text/number input keeps its local draft while live query results refresh, so background updates do not overwrite typing before blur. Page titles use a separate title revision. Kanban supports drag handles and keyboard-accessible status selectors; updates persist on the server and invalidate the other views. The UI supports record creation, optional private records, page opening, property creation, view settings and database permission management. Existing/private parent restrictions still apply to every record.

Cell drafts are held in memory separately from server snapshots, including choices in open multi-select pickers. Failed text, scalar, multiple-choice, file and relation writes remain visible through refresh, pagination, filters and view changes in an expandable recovery panel. Per-record writes are queued; unrelated concurrent changes can be rebased, while same-field conflicts show the current saved value and require an explicit choice. Retry rechecks current values and access, including a response lost after a successful commit. Navigation waits for writes and blocks on unresolved drafts; closing/reloading the tab uses the browser's unsaved-changes warning. Discard is explicit. Drafts are not persisted across a forced reload or browser crash. Drafts outside the current query are revalidated during refresh and at most every five seconds; inaccessible records clear their local values. Database access loss clears all drafts.

`tests/database-drafts.test.mjs` covers simulated transport failures across field types, explicit recovery, edits queued during a held request, unrelated/same-field races, keyboard navigation before blur, actual unload cancellation, off-view selection drafts, discard and active record access revocation.

## Live updates and privacy

PostgreSQL notifications deliver committed invalidations to all collaboration replicas. An authenticated database-room subscription receives a minimal refresh message, then fetches its authorized records through the API. It never receives raw record values through a notification.

The server checks whether a changed record is readable before announcing its activity. Clients register the currently visible record IDs, validated server-side. A formerly visible record becoming private triggers one refresh so it disappears; subsequent hidden activity is not announced. New private records are never announced to unauthorized viewers. The outbound authorization queue also protects these messages and closes revoked database subscriptions. Reconnect reloads current data, with fallback refresh while the live connection is unavailable.

## Validation

API tests cover real record-pages, types, invalid dates, metadata write rejection, saved filters/sorts, selected-property projection, pagination, calendar ranges, private records, move constraints, trash/restore and cross-user isolation. Two-replica tests cover live invalidation, hidden activity suppression and membership revocation. Chromium covers all five views, actual drag-and-drop, a second window's live update, record document persistence, property creation and saved filtering.

## Linked database blocks

The editor's Link database command inserts an `orvynDatabase` atom containing the source database UUID and saved view UUID, rather than copying records. Users may select an existing view, create an independent saved view, or create a database beneath the current document. New documents use schema version 2; version 1 remains readable. Servers reject future document schemas instead of silently dropping unknown nodes.

The linked workspace queries the source with the current user's session. A link grants no access. An unavailable source displays a generic message without its title, records or schema. Source permission changes apply to embeds and live subscriptions. Opening an embedded record navigates to its original page and notes. Each workspace has distinct form IDs, including repeated references to the same source.

## CSV transfer and JSON export

CSV import accepts UTF-8 with quoted multiline fields, up to 1 MiB, 1,000 nonblank records and 50 columns. Preview proposes existing-property matches and new Text properties, with explicit remapping/skip/type controls. A title mapping is mandatory. Computed metadata cannot be imported. Select labels may create new options only when allowed; multiselect uses a JSON array or semicolon-separated labels. Numbers use canonical decimal/exponent syntax, dates use ISO dates, and checkbox values accept true/false, yes/no or 1/0. Invalid typed values show row/column errors and disable confirmation.

Preview stores only a short-lived actor-scoped plan and file digest; it does not create database properties or records. Confirmation requires the same file, current write access and the same schema revision. Properties, options, record pages, typed values and initial history commit together. Confirmation retries return the stored outcome for 24 hours instead of duplicating records. Imports create new records; they never overwrite matching titles. CSV previews expire after 15 minutes. One committed database notification refreshes clients after the batch.

CSV and JSON exports evaluate per-record access inside a repeatable-read transaction. An explicit view uses its saved filters and selected columns, including the title/group/date columns required for rendering. Without a view, all accessible records and properties are exported. Search text, loaded pagination and the displayed calendar month do not limit exports. Exports fail explicitly beyond 10,000 records or 10 MiB of serialized records; they never silently truncate.

CSV uses readable select labels and JSON arrays for multiselect. By default text starting with spreadsheet formula control characters is prefixed with an apostrophe; numeric cells remain numeric. The API supports `spreadsheetSafe=false` for exact CSV text when required. JSON always preserves exact values and includes schema, saved views, page document projections and ready attachment metadata. It does not package attachment bytes or constitute a full application backup; use the backup/recovery workflow for that.

Transfer tests cover preview isolation, typed failures, file/schema changes, idempotency, private-record filtering, saved-view projection, spreadsheet safety, and the real browser mapping/confirm/download flow. Embedded browser tests cover independent views, persistence, original record navigation, denied source privacy and re-granted access.

## People properties

Person values are unique arrays of up to 50 user UUIDs. The UI offers current space members (including the owner), with contains, exact-set equality and empty filters. Person lists do not have arbitrary text sorting. Assignment never creates membership or page permissions.

New assignments must reference current space members. Writes share the space lock used by membership administration, so revocation cannot race a new assignment. Existing references to former members may be kept or removed while editing; they cannot be assigned anew. The UI uses a generic former-member label when a UUID is absent from the authorized directory and does not look up global accounts. JSON and CSV preserve stable user IDs; CSV import also accepts member emails separated by semicolons or a JSON string array. Confirmation resolves current membership again, including after a valid preview.

## File properties

Files values contain up to 50 unique attachment UUIDs belonging to that record page. Create the record, open it to upload attachments through private S3 storage, then select attachments in the table. Multiple Files properties may reference the same attachment. Field choices and downloads remain protected by record access; selecting an ID never copies or grants access to files from another page.

The API accepts only ready attachments of the target record. New records cannot start with arbitrary external file references. Table fields offer multiple selection and authorized downloads; cards display selected filenames. Removing an attachment hides its IDs and metadata from field projections, filters and exports immediately, while stored references remain available for audit/history. Attachment state changes advance the record revision and deliver the normal privacy-checked live invalidation. Filtering uses the same sanitized projection, so deleted files cannot be discovered by contains/equality/empty filters.

CSV exports file UUID arrays, but imports skip file columns and reject explicit mapping to Files fields. Importing attachment bytes requires the separate file upload workflow; opaque IDs in an imported spreadsheet cannot link to existing private files. JSON export includes only ready attachment metadata, never object-storage credentials or signed public links. File fields currently support empty/not-empty filtering in the UI and UUID-set/contains filters in the API; sorting file lists is intentionally rejected.
