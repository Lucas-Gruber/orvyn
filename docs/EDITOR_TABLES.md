# Document tables

`/Table` inserts a three-column, three-row table with a header row. Empty cells keep a visible caret without repeating the document placeholder. Selecting a cell opens a table toolbar with row/column insertion and deletion, header row/column toggles, merge/split, width reset and continuation below the table. `Mod+Enter` also continues below a table; it retains code-block behavior inside code cells.

Column edges use ProseMirror's native resize interaction. Widths persist in the collaborative document and update live readers. The column menu also offers a numeric width dialog (96–2000 pixels). Escape, window blur, loss of edit permission and editor disposal cancel an unfinished drag. Read-only documents expose neither the toolbar nor resize interaction. Link cursors indicate clickable text in both editable and read-only documents.

Schema 12 accepts ProseMirror's zero sentinel for an unspecified width inside a merged cell. Negative, fractional and oversized stored widths remain invalid. Migration 41 changes the default schema version for new pages without rewriting existing documents. Structural menu actions validate the resulting document against the existing size, node and depth budgets before applying it. Native resize transactions are normalized and checked before persistence.

Tables scroll horizontally when wider than the document, including on mobile. Tests cover insertion, menus, header toggles, explicit and pointer widths, merged cells, persistence, live readers, cancellation, permission changes, link cursors and narrow layouts. Touch column dragging, spreadsheet formulas and independent row reordering remain outside this slice.
