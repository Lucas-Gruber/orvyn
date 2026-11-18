# Document block controls

Hover a block to reveal its left-hand grip. Click for a keyboard-accessible menu with move up/down, duplicate and delete. Shift-click handles to select a contiguous range; drag any selected grip to move the whole range. A line marks the destination. Grips are also reachable by Tab and are absent in read-only documents.

`Ctrl/Cmd Shift Space` selects the current document block or expands a text selection to complete blocks. `Alt Shift Up/Down` moves the selection across an adjacent block. Delete/Backspace removes selected blocks, Escape returns to text editing, and Enter creates a paragraph after the selection. Copy/cut uses a closed ProseMirror slice containing whole blocks. Deleting the entire document retains the schema's empty paragraph.

These controls reorder **top-level document children**. A list, table, callout, toggle or column layout moves as one unit with its nested content. Dragging individual nested items across containers, marquee selection, and column restructuring remain unimplemented. Ordinary nested text selection/editing remains available. Column resizing is described in EDITOR_LAYOUT.md.

Movement preserves block attributes, marks, file/database/page references and heading IDs. Duplication runs the editor's existing heading identity normalization, leaving the original target intact and generating new IDs for copies. Selected ranges and active drag ranges map through document transactions; invalidated ranges fall back or cancel. The drag payload is scoped to the originating editor. Drops inside the source range are no-ops. Server validation and edit permissions continue to govern document writes.

Movement, duplication and deletion are distinct history operations. The block extension explicitly uses the same `@tiptap/y-tiptap` undo key as the installed collaboration extension; the separate `y-prosemirror` package remains responsible for shared-schema conversion. No document schema migration is needed: grips, selection, menus and drop indicators are local decorations, never stored in the document.

Model tests verify closed slices, selection serialization/bookmarks, mapped edits/deletion, valid document structure and boundary behavior. Chromium tests use real handles and native drag events, cover group movement, duplicate heading IDs, deletion, individual undo, live readers without controls and persisted reload.
