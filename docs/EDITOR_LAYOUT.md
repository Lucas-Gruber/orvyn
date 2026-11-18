# Columns and selection formatting

Use `/2 columns` or `/3 columns` to create balanced, editable columns. They contain normal rich blocks and share the document's permissions, collaboration, history and persistence. The insertion command focuses the first column. `Ctrl/Cmd Enter` exits the nearest callout, toggle or columns container into a paragraph after it. Nested containers exit one level at a time.

Drag the divider between columns to resize the adjacent pair. Each column retains at least 15% of the layout width. Focus a divider and use Left/Right for 2% steps, Shift Left/Right for 10% steps, or Home/End for the limits. Double-click a divider or choose Equal widths to balance the layout again. Escape or pointer cancellation abandons an active gesture. A drag previews locally and commits one undoable document change on release; remote width changes cancel an unfinished local gesture rather than overwriting the remote layout. Content edits continue normally during resizing.

On screens up to 760px wide, columns stack in their original reading order and resizing controls disappear. Saved proportions return on wider screens. Empty columns remain editable. Drag-based restructuring is not implemented yet.

Selecting text shows a floating toolbar for bold, italic, underline, strikethrough, internal links and clearing formatting. It preserves the selection when its buttons are clicked and remains usable while its own controls have focus. It is hidden in read-only documents and code blocks. The existing top toolbar remains available for other editing operations.

Schema version 8 introduced columns and column child nodes, with structural validation requiring exactly two or three nonempty block containers. Version 11 adds optional column proportions: two or three integer shares totaling 10,000, each at least 1,500. Existing layouts without shares remain equal. Migration 35 updates new-page defaults without rewriting existing documents or histories. Upgrade all web/API/collaboration replicas together and reload older editor tabs.

Schema tests cover Yjs round trips, malformed proportions, invalid counts and standalone columns. Chromium tests cover pointer and keyboard resizing, minimum widths, cancellation, independent undo/redo, concurrent resizing, live readers without controls, mobile stacking/no overflow and persisted proportions, plus insertion, formatting/linking and exit shortcuts. Document-level block selection/movement and native drag handles are described in BLOCK_CONTROLS.md.
