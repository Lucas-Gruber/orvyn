# Columns and selection formatting

Use `/2 columns` or `/3 columns` to create balanced, editable columns. They contain normal rich blocks and share the document's permissions, collaboration, history and persistence. The insertion command focuses the first column. `Ctrl/Cmd Enter` exits the nearest callout, toggle or columns container into a paragraph after it. Nested containers exit one level at a time.

On screens up to 760px wide, columns stack in their original reading order. Empty columns remain editable. Column resizing and drag-based restructuring are not implemented yet; the supported layouts have two or three equal columns.

Selecting text shows a floating toolbar for bold, italic, underline, strikethrough, internal links and clearing formatting. It preserves the selection when its buttons are clicked and remains usable while its own controls have focus. It is hidden in read-only documents and code blocks. The existing top toolbar remains available for other editing operations.

Schema version 8 adds columns and column child nodes, with structural validation requiring exactly two or three nonempty block containers. Migration 20 updates new-page defaults without replacing old document histories. Upgrade all web/API/collaboration replicas together and reload older editor tabs.

Schema tests cover round trips, invalid counts and standalone columns. Chromium tests cover insertion, both columns' content, formatted/linked selections, exit shortcuts, a second reader, mobile stacking/no overflow and reload persistence. Document-level block selection/movement and native drag handles are described in BLOCK_CONTROLS.md.
