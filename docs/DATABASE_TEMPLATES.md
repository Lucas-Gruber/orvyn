# Database and record templates

Save a database from **Database options → Save as template**. Open **Templates** in the sidebar to preview, use or manage saved database schemas. A new database receives independent property, option and view IDs, including rebound formulas, self-relations, rollups, filters and sorts. It starts without records. External relations, including targets in other accessible spaces, retain their target and require current target access. Self-paired relations receive independent matching IDs/registrations. An external paired relation becomes one-way in a schema clone, preserving the original target schema. Record-template defaults in the original database maintain the existing matching property when applied.

Save a record from its page actions or row context menu. **New record → Start with a template** applies its saved document, attachments and property defaults. The preview and template library support choosing, renaming, refreshing from the original record and deleting templates. Title and property overrides are kept when changing templates if the user has already changed those fields.

Templates are snapshots. Later edits to the original page do not change them until **Refresh from source** is chosen. Record templates belong to their original database; database templates create new databases in the original space. This release does not implement cross-space template transfer or automatic default templates.

## Copies and permissions

Creating or managing a template requires current write access to both its database and its source page. Listing and previewing require current read access to both; templates do not grant access to their source. Source trashing, deletion or access revocation also affects template availability. Applying a record template requires write access to its destination database; schema templates require permission to create in their space and chosen parent. New pages may be restricted to their creator and the space owner.

Defaults are checked against the current schema. Former member assignments, removed options, missing fields and unreadable relation targets are omitted. Files must remain ready and readable when previewed and applied. Attachment bytes are copied into private, independent objects with new file IDs; source and destination rights are checked again before the database transaction commits. Failed copies do not create a page, and cleanup preserves objects referenced by a committed transaction. Copies are bounded to 50 attachments and 100 MiB; snapshots to 2 MiB. A creator may save up to 100 templates per space.

Copied headings receive fresh identities. Links and preview cards pointing back into the source record are redirected to the copied page and corresponding headings. Other page links retain their target and normal access checks. Inline person mentions are revalidated for the copied page; unavailable people become plain text instead of creating invalid mentions or notifications. Discussion threads, permissions, history and database records are not copied from the source.

Apply requests carry an actor-scoped request UUID and template version. Identical concurrent requests and retries return one created page; changing a request's payload returns a conflict. Template refresh/rename/delete use optimistic versions. Source and relevant attachment spaces are locked in a stable order around permission checks; object copying happens outside the database transaction.

## Validation

`tests/database-templates.test.mjs` exercises schema/reference rebinding, independent views, concurrent retry deduplication, frozen defaults, file bytes and identity remapping, heading self-links, former-member cleanup, version conflicts and source-access revocation. `tests/database-ux.test.mjs` covers saving both template kinds, creating a record with copied content/defaults and creating an empty database from a saved schema through the real browser interface.
