# Document and heading links

## Using links

- Type `/` at the start of a paragraph to select a block. Filter by typing its name, navigate with arrow keys, select with Enter and dismiss with Escape. Supported commands include headings, paragraphs, lists, checklists, quotes, code blocks, dividers, tables, linked databases and **Link to document**.
- Type `/link` (also `/page`, `/seite` or `/dokument`), choose **Link to document**, search for a document, then choose **Link entire document** or one of its headings.
- Select existing text and press **Ctrl/Cmd K** while the document editor has focus to make that text a link. The toolbar link button opens the same picker. Outside the editor, Ctrl/Cmd K still opens workspace search.
- Hover over a heading or focus its `#` button to copy a direct link. The button remains visible on mobile screens. Read-only readers can also copy links.
- Click an internal link to navigate within the workspace. Modified clicks and the browser's link actions can open it in another tab. A direct link also opens after signing in with a local account.

The picker searches titles across authorized spaces and shows the chosen document's current headings, including nested headings. It does not create sample content or grant permissions. Custom link text is optional; labels remain the text authored in the source document, even if the destination is subsequently renamed.

## Permanent anchors and older documents

Document URLs use the page's UUID, for example `/?page=<page UUID>`. A heading adds `#h-<heading identity>`. The URL does not require a space parameter. Opening a destination resolves its current space after checking access.

Heading identities live in the document itself and persist through Yjs, JSON projections, revisions and reloads. Editing a heading's text or level keeps its identity. Newly created or pasted headings get their own identity; copied HTML cannot steal the original heading's identity.

Older documents without stored heading identities have deterministic initial anchors, including separate anchors for duplicate labels. A read-only client can render and copy those links without changing the document. An editable client stores those same initial identities through the normal acknowledged collaboration channel before editing. Later renames retain the original anchor.

Schema version 3 adds the optional validated heading attribute. Database migration 14 updates the default for new documents; it does not replace existing CRDT histories. Existing documents remain readable. Servers predating this schema must not serve pages written with the new format.

Upgrade the web app, API and all collaboration replicas together and reload already-open editor tabs. Mixed-schema rolling upgrades are not supported.

If a heading is deleted or converted into another block type, opening its old link shows the document with an explanation that the heading is missing. No unrelated heading is chosen as a fallback.

## Access and validation

`GET /api/v1/pages/:id/headings` applies the same inherited page access check as opening the document. Inaccessible, unrelated or trashed documents do not expose headings. Following a link never adds a member, changes a grant or bypasses parent restrictions. Creating a link requires edit access to its source document; accessing the destination requires its own read permission.

Heading IDs have a bounded format and are never interpreted as HTML or selectors supplied by a destination title. Link labels render as text. External link protocol validation and document size/structure bounds continue to apply.

The **Backlinks** section below a document lists accessible documents that link to it. References are indexed in the same transaction as a REST or acknowledged collaborative document write; removing a link removes its reference. Migration 15 backfills existing documents without changing their content or CRDT history. Sources and destinations are checked against current inherited permissions at read time. Trashed sources are hidden and return on restoration; links never grant access. The section loads on demand, has bounded pagination and can be refreshed; an open first page refreshes every five seconds while the tab is visible. Sources linking to themselves are omitted.

`tests/document-links.test.mjs` covers permission filtering, slash commands, links across spaces, selected labels, stable anchors after renames, clipboard links, reload/new tabs, sign-in continuation, read-only legacy documents, active revocation, missing destinations and navigation through backlinks. Backlink API tests cover pagination, restricted sources, link removal, deletion, restoration and membership revocation. Shared-schema tests cover ID preservation and invalid anchors. Dynamic mentions remain a separate unfinished feature.
