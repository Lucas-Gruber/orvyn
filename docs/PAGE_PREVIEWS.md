# Document preview cards

Type `/preview`, select **Page preview**, then choose a document or one of its headings. The editor inserts a card rather than a copied document. Ordinary `/link` and selected-text links continue to insert text links.

The card loads a permission-checked title, space name, optional heading label and a plain-text excerpt of up to 280 characters. It can open the original document at the heading and supports normal modified link clicks. Refresh reloads metadata, including renamed titles or changed access. Read-only readers can follow and refresh cards; editors can remove them.

Only destination/heading IDs are persisted. Private titles, excerpts and cached rendering are not copied into the source document or its exported JSON. An inaccessible, deleted or trashed destination displays a generic unavailable state. A missing heading is identified separately and the document can still be opened. Previews never grant access to the destination or its attachments.

Metadata loads as a card approaches the viewport and when explicitly refreshed. It is not a real-time title subscription; already-read metadata remains until refresh or reload. The response uses private/no-store caching. The server never fetches an external URL and does not recursively expand preview nodes; cyclic references remain bounded. External website cards and media embeds are separate features.

Cards participate in the transactionally maintained backlinks index. Removing a card removes its current backlink after the document write is acknowledged. A history entry containing an old card does not create a current backlink.

Schema version 6 adds the page preview reference node; migration 18 updates the default for new pages. Upgrade all web/API/collaboration replicas together and reload open editor tabs.

Tests cover schema round trips, invalid references, content-free stored attributes, bounded metadata, access checks, trash, missing headings, cyclic references, slash insertion, heading navigation, renamed titles, read-only readers, revoked access and backlink removal. Browser screenshots use test documents in `.local/ui-review/page-preview.png`.
