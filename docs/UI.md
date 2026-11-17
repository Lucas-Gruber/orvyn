# Workspace interface

The workspace has a persistent sidebar, a collapsible page hierarchy, breadcrumbs and a document area. Creating a page opens and focuses its title immediately. Title changes save on blur or after a short pause; navigation waits for pending title writes and acknowledged document changes. A failed save keeps the current page open. Concurrent title changes offer an explicit choice to use the saved title or keep the local title, and block navigation until resolved. Closing a tab with an unsaved title or unacknowledged document changes prompts the browser's unsaved-changes confirmation.

Workspace search (`Ctrl/Cmd K` outside the document editor) queries titles across the signed-in user's authorized spaces. Results are filtered by the same inherited page permissions as opening a page. Trashed and inaccessible pages are excluded. The URL identifies the current space and page, so reloading or returning through browser history opens the same authorized page.

The sidebar shows favorites and recent pages. Only their IDs are stored in per-account device preferences; labels come from the current authorized page list. These preferences are not yet synchronized across devices. Pages outside the currently loaded sidebar batch can be found through search or by loading more pages.

The document editor supports slash commands and internal links to documents and stable headings; Ctrl/Cmd K inside the editor opens the link picker (see DOCUMENT_LINKS.md). Page actions contain width, attachments, history, permissions, move and trash operations. New databases and spaces use dialogs. Database views retain real filters, sorting, property editing, pagination, live updates, record pages and imports/exports. Person, multi-select and attachment fields use searchable multiple-choice popovers. Board cards have both drag controls and a keyboard-accessible status selector.

## Design system

- Semantic CSS tokens in `apps/web/app/assets/css/app.css` define Cybercade, Graphite, Midnight, Nord, Carbon, Matrix and Light. Appearance changes apply immediately and persist on the current device.
- Inter Variable and JetBrains Mono Variable are bundled locally. Font and Lucide licenses are in `apps/web/public/licenses`.
- `UiDialog` uses native modal dialogs with focus containment, Escape and focus return. `UiMenu` supports arrow keys, Home/End, Escape and outside dismissal. `UiMultiSelect` uses the native popover layer and selectable options with selected states.
- The hierarchy supports arrow-key navigation and expansion. On small screens, navigation becomes an overlay and the obscured area is inert. Motion respects the operating system's reduced-motion preference.
- Existing records and pages are the only product content. The authentication illustration is decorative. Empty, loading, disconnected, read-only and failure states reflect actual application state.

## Verification and current boundaries

`tests/ui-workflow.test.mjs` exercises creation, title autosave and conflict recovery, hierarchy navigation, moves, trash/restore, search, favorites, deep links, all seven themes and mobile navigation in Chromium. Existing browser tests cover account management, uploads, five database views, live Kanban, people/files properties, linked databases and CSV transfer. Screenshots are written to ignored `.local/ui-review/` during these tests.

The interface is currently English. Full localization, synchronized preferences, whiteboards and public sharing remain unfinished product requirements. A complete assistive-technology and cross-browser audit is still required.

## Editor and database interaction

Markdown heading input supports H1–H4 and keeps an empty editable text position, with a faint `#`, `##`, `###` or `####` gutter marker, an empty-heading hint and a text-style selector in the toolbar. Levels are available through Markdown, slash commands, the selector and `Ctrl/Cmd Alt 1` through `4`; changing the level preserves the heading anchor. The heading permalink button is inserted only once a heading has content. The slash menu puts basic text blocks first and gives every command an icon and description.

Records open in a side peek by default. The row menu, right-click menu and keyboard actions also offer a center modal or full page. Each saved view can choose its default opening mode. Peek URLs survive reload, and switching between side and center keeps the same editor instance. Both peeks expose the real document, editable properties, comments, appearance, attachments and template actions. Closing, opening another record or expanding to a full page waits for pending property, title and document writes; failed property drafts remain available for explicit retry/discard. Unsaved page titles, property drafts and unacknowledged document changes participate in the browser's unload warning.

Table headers have field-type icons and rows expose action buttons on hover/focus (always on touch). Adding a property uses a dialog with the same spacing as other forms. Multi-select changes commit when the picker closes, so removing the last matching value does not remove a filtered row halfway through choosing. Native popovers keep pickers and context menus above dialogs. Sidebar page context menus provide supported opening, copy-link and subpage actions; Shift-right-click retains the browser menu.

**Keyboard shortcuts** in the sidebar lists the supported keys with platform-specific labels. The editor retains its formatting, Markdown, undo and block/hierarchy shortcuts. Workspace actions include search (`Ctrl/Cmd P`, or `Ctrl/Cmd K` outside the editor), sidebar toggle (`Ctrl/Cmd \\`), new page/database (`Ctrl/Cmd Alt N/D`), theme toggle (`Ctrl/Cmd Shift L`) and shortcut help (`Ctrl/Cmd /`). Databases support new record (`Ctrl/Cmd Alt R`), view settings (`Ctrl/Cmd Alt F`), search focus (`/` outside a text input), center peek (`Shift Enter`) and full-page opening (`Ctrl/Cmd Enter`) on a focused record. Arrow keys navigate menus/tabs; `Shift F10` opens a focused item's context menu. `Ctrl/Cmd Enter` submits dialog forms outside a rich-text editor.

`tests/editor-ux.test.mjs` checks empty-heading selection/markers, toolbar state, slash icons, dialog padding and mobile overflow. `tests/database-ux.test.mjs` checks all three opening modes, live edits, held-write navigation, focus return, view defaults, reload, templates, context menu keyboard control and shortcut help. See DATABASE_TEMPLATES.md for template scope and access rules.
