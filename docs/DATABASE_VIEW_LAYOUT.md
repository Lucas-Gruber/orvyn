# Database view properties

Open **Properties** in a database's view bar to choose visible fields and arrange their display order. The dialog has a separate row for each field, type icons, visibility checkboxes, drag grips and move up/down buttons. Focus a grip and use `Alt Shift Up/Down` for repeated keyboard movement; focus follows the moved row. Cancel discards the dialog draft, Reset layout restores the database's canonical order and all fields, and Save layout persists only that view's layout while retaining its filters, sorting, opening mode and grouping/date settings.

Table headers also have grips, revealed on hover/focus. Drag left/right across another column to place it before/after that column. `Alt Shift Left/Right` on a focused grip moves across the adjacent visible column. Hidden fields retain their position in the full order. The title remains first and visible. A board's grouping field and a calendar's date field remain visible because their view requires them. Every optional field can be hidden, leaving only the title when no other field is required.

## Persistence and compatibility

`ViewConfig.propertyOrder` is an optional list of up to 50 active property UUIDs. IDs must be unique and belong to the same database. Older configurations without an order retain canonical schema order. Partial orders are valid: explicitly listed non-title properties come first and remaining/new properties follow in their canonical order. The title always precedes them, regardless of its position in the supplied list.

`visibleProperties: []` continues to mean all fields, preserving existing views. Explicit title-only visibility uses the title UUID rather than an empty list. Visibility is presentation, not a property-level access boundary. Current record/database permissions continue to govern queries, exports and mutations.

The same shared ordering function drives table, board/list/gallery property projections and scoped CSV/JSON export. Database templates map every ordered UUID to its independent cloned property. Property deletion removes the old ID from saved orders and increments affected view versions. Restoring a field preserves subsequent view choices and places an unlisted restored field after the explicit order. Global property/schema order and record values are unchanged.

Changes use the view's optimistic revision. A dialog keeps its local layout after a failed write. A conflicting view offers Reload saved layout; it does not silently rebase over newer filters or other settings. Header movement reloads after failures and reports the error. It participates in the workspace's pending-write queue. Layout changes await outstanding cell requests but do not retry or discard failed cell drafts; an unsaved value remains in the recovery panel even when its column is hidden.

This is an additive JSON configuration field and needs no database migration. Upgrade web and API replicas together before using the new controls.

## Verification

`tests/database-view-layout.test.mjs` checks title/required-field preservation, partial orders, nonmutation of source metadata, ID/role/version validation, independent views, exports, template ID rebinding, deletion/restoration repair and real Chromium interaction. Browser checks cover repeated keyboard movement with retained focus, header drag/keyboard movement, failed cell recovery after hiding a column, explicit conflict reload preserving newer sorts, reset, mobile geometry and persisted reload.

Column resizing and property type conversion remain separate unfinished work.
