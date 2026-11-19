# Kanban cards and movement

Board cards open their record in the saved side/modal/full-page mode. They contain no inline property inputs. They display nonempty visible properties, a compact title and an optional private image preview. Context-menu and Shift/Mod+Enter record-opening actions remain available. Group headings show the number of records on the currently loaded page; the board does not imply it has loaded every record.

An explicit preset/file cover takes priority. Otherwise previews choose the first ready image owned by the record in document order, including nested blocks, then the first ready image attachment. `previewFileId` is distinct from `coverFileId`: choosing an icon or removing a page cover does not suppress content previews. Foreign-page images and unsafe MIME types are excluded. Image bytes still require current file/page permission; failed previews disappear without a broken-image placeholder. The same permission-filtered record query serves readers and editors.

Cards can move between groups by dragging the card/grip, using the grip's “Move record to” menu, or pressing Alt+Shift+Left/Right on a focused card. Keyboard/menu moves retain focus on the moved card. Mobile users can use the menu. New-page actions initialize the selected group.

Drag feedback includes a source ghost, target highlight, drop placeholder and automatic horizontal/vertical scrolling. Escape, window blur, view/group changes, lost edit permission and component disposal clear drag state. Payloads are scoped to the current database/view and require a local drag; arbitrary text drops are ignored. If the grouping value changes elsewhere during a drag, the outdated drop is cancelled. Other field edits use the existing per-record conflict/rebase queue. Failed moves keep a visible local draft and require explicit retry/discard.

Ordering inside a group continues to follow the saved view's server-side sorting. This slice implements group movement, not independent manual card ordering or touch drag gestures. Tests cover owned/nested image selection, explicit covers, private records/files, opening modes, native dragging, keyboard/menu/mobile moves, cancellation, foreign drops, concurrent moves and failed-write recovery.

Refresh queries that began before a locally acknowledged record write are discarded and retried. They cannot briefly move an already-saved card back to its old group or detach a handle during the next drag. A browser regression holds an old query response across a committed move to verify this ordering.
