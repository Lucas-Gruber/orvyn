# Structured databases

## ADR 005: Record-pages with shared authorization

A database is a regular page of kind database. A record is a regular page of kind record with a database_records row; its parent is its database page. A composite foreign key enforces that association. Record pages support the existing editor, Yjs state, attachments, subpages, permissions, trash and history. Generic moves cannot remove a record from its database. Database moves preserve their prior audience through the existing page policy.

Database properties and views have their own tables. Record values use validated JSONB keyed by stable property UUID, with database and JSONB indexes. Schema/property IDs and API contracts are shared between web and backend in @orvyn/shared using Zod 4.6.7 (MIT). Adding or renaming properties does not rename record value keys.

Working property types: Title (managed by the page), Text, Number, Select, MultiSelect, Status, Date, Checkbox, URL, Email, Phone, CreatedTime, CreatedBy, LastEditedTime and LastEditedBy. Metadata is read-only. Date values are canonical ISO dates; metadata timestamps are UTC ISO instants. Legacy page timestamps/actors are backfilled from the first/last known content revisions, falling back to the space owner and migration time where older evidence is absent.

Person, Files as a structured property, Relation, Formula and Rollup are reserved in the model but not implemented or offered as working properties. Option editing/deletion, property deletion/restore, templates and import/export are not implemented yet. Reserved property types return a validation error; no placeholder computation is returned.

## Views and editing

Table, Board, List, Calendar and Gallery use the same records. Saved views retain filters, sorts, selected properties, grouping and calendar date property. Title remains available to open the full record page. A view's group/date property is also projected when needed to render it. Timeline is not implemented.

Queries filter each record through orvyn_page_role before ordering or pagination. Search, property filters and sorts execute on PostgreSQL. Values are type-checked before persistence; property types are immutable in the current API. Filters are parameterized and operators/directions are allowlisted. A view query returns only its selected properties plus the fields needed to render that view; view column visibility is a presentation rule, not an independent property-level ACL.

Results paginate at 100 records by default, maximum 200, with explicit offsets and nextOffset. Board counts refer to the current loaded page. Deep-offset performance, very large datasets and field-specific index tuning have not been benchmarked.

Property cells save through optimistic record revisions. Page titles use a separate title revision. Kanban supports drag handles and keyboard-accessible status selectors; updates persist on the server and invalidate the other views. The UI supports record creation, optional private records, page opening, property creation, view settings and database permission management. Existing/private parent restrictions still apply to every record.

## Live updates and privacy

PostgreSQL notifications deliver committed invalidations to all collaboration replicas. An authenticated database-room subscription receives a minimal refresh message, then fetches its authorized records through the API. It never receives raw record values through a notification.

The server checks whether a changed record is readable before announcing its activity. Clients register the currently visible record IDs, validated server-side. A formerly visible record becoming private triggers one refresh so it disappears; subsequent hidden activity is not announced. New private records are never announced to unauthorized viewers. The outbound authorization queue also protects these messages and closes revoked database subscriptions. Reconnect reloads current data, with fallback refresh while the live connection is unavailable.

## Validation

API tests cover real record-pages, types, invalid dates, metadata write rejection, saved filters/sorts, selected-property projection, pagination, calendar ranges, private records, move constraints, trash/restore and cross-user isolation. Two-replica tests cover live invalidation, hidden activity suppression and membership revocation. Chromium covers all five views, actual drag-and-drop, a second window's live update, record document persistence, property creation and saved filtering.
