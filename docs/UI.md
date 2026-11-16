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

The interface is currently English. Full localization, synchronized preferences, page icons/covers, a draggable hierarchy, templates, comments, whiteboards and public sharing remain separate unfinished product requirements. These controls are not presented as working features. A complete assistive-technology and cross-browser audit is still required.
