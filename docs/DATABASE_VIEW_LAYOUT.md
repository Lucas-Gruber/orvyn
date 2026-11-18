# Database view properties

Open **Properties** in a database's view bar to choose visible fields and arrange their display order. The dialog has a separate row for each field, type icons, visibility checkboxes, drag grips and move up/down buttons. Focus a grip and use `Alt Shift Up/Down` for repeated keyboard movement; focus follows the moved row. Cancel discards the dialog draft, Reset layout restores the database's canonical order and all fields, and Save layout persists only that view's layout while retaining its filters, sorting, opening mode and grouping/date settings.

Table headers also have grips, revealed on hover/focus. Drag left/right across another column to place it before/after that column. `Alt Shift Left/Right` on a focused grip moves across the adjacent visible column. Hidden fields retain their position in the full order. The title remains first and visible. A board's grouping field and a calendar's date field remain visible because their view requires them. Every optional field can be hidden, leaving only the title when no other field is required.

Each table header also has a resize boundary. Drag to preview its width and release to save once; Escape, pointer cancellation or a changed view/schema discards the active gesture. Focus the boundary and use Left/Right for 10 pixels, Shift Left/Right for 50 pixels, Home for that field's minimum and End for 960 pixels. Enter or double-click restores the field's default width. Keyboard focus remains on the boundary after saving. Resize and reorder hit areas are separate, and native column dragging does not start a resize.

Widths belong to the saved view and update live for current readers. Read-only viewers see the saved layout without resize controls. Tables scroll inside their container on narrow screens rather than forcing the entire page wider. Other view types retain their existing layouts.

## Persistence and compatibility

`ViewConfig.propertyOrder` is an optional list of up to 50 active property UUIDs. IDs must be unique and belong to the same database. Older configurations without an order retain canonical schema order. Partial orders are valid: explicitly listed non-title properties come first and remaining/new properties follow in their canonical order. The title always precedes them, regardless of its position in the supplied list.

`ViewConfig.propertyWidths` is an optional map of up to 50 active property UUIDs to integer pixel widths. Values range from the property's shared minimum (100–200 pixels depending on field type) to 960 pixels. Missing entries use type-specific defaults. The API rejects foreign/deleted IDs, noninteger/out-of-range values and widths below the field's minimum. Header reset removes an explicit override; configuring order/visibility retains existing widths. Templates remap width keys to cloned property IDs. Property deletion removes its width override while preserving other widths, and restoring a field uses its default until resized again.

`visibleProperties: []` continues to mean all fields, preserving existing views. Explicit title-only visibility uses the title UUID rather than an empty list. Visibility is presentation, not a property-level access boundary. Current record/database permissions continue to govern queries, exports and mutations.

The same shared ordering function drives table, board/list/gallery property projections and scoped CSV/JSON export. Database templates map every ordered UUID to its independent cloned property. Property deletion removes the old ID from saved orders and increments affected view versions. Restoring a field preserves subsequent view choices and places an unlisted restored field after the explicit order. Global property/schema order and record values are unchanged.

Changes use the view's optimistic revision. A dialog keeps its local layout after a failed write. A conflicting view offers Reload saved layout; it does not silently rebase over newer filters or other settings. Header movement reloads after failures and reports the error. It participates in the workspace's pending-write queue. Layout changes await outstanding cell requests but do not retry or discard failed cell drafts; an unsaved value remains in the recovery panel even when its column is hidden.

Width writes use the same pending-write queue and revision checks. A successful response updates the local saved view before reloading; failures discard the width preview and reload current settings. Concurrent view changes cancel a gesture or reject its stale write. Failed cell drafts remain available through either case, and record values/versions do not change when resizing columns.

These are additive JSON configuration fields and need no database migration. Upgrade web and API replicas together before using the new controls.

## Verification

`tests/database-view-layout.test.mjs` checks title/required-field preservation, partial orders, nonmutation of source metadata, ID/role/version validation, independent views, exports, template ID rebinding, deletion/restoration repair and real Chromium interaction. Browser checks cover repeated keyboard movement with retained focus, header drag/keyboard movement, failed cell recovery after hiding a column, explicit conflict reload preserving newer sorts, reset, mobile geometry and persisted reload.

`tests/database-column-widths.test.mjs` covers active-ID/type-limit/role/revision checks, independent views, template rebinding, delete/restore repair and unchanged record data. Chromium checks pointer previews with one commit on release, Escape/pointer cancellation, remote gesture cancellation, keyboard limits/reset/focus, double-click reset, live readers, per-view reload, mobile geometry, stale writes and retained failed cell drafts. Existing header drag/keyboard tests guard the separation of move and resize controls.

Property type conversion remains separate unfinished work.
