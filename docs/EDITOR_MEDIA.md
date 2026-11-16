# Images and files in documents

Use `/image` or `/file` to upload and insert an attachment directly in the editor, or select an existing attachment from the current page. Image descriptions and file labels are optional. Images support PNG, JPEG, GIF and WebP; other formats remain downloadable attachments. The picker displays the configured upload limit and the latest 200 existing attachments.

The document stores an attachment ID and an authored description/label. It does not contain a public bucket URL, arbitrary image URL or copied file bytes. New references must point to ready files the author can read; image references additionally require a supported raster media type. REST writes and collaborative updates enforce this before committing. Existing references to deleted or subsequently restricted files do not prevent editing unrelated document content.

Each viewer separately requests private attachment metadata and preview/download bytes. Both requests recheck the owning page's inherited permissions. A reference to an attachment from another page never grants access to that page or file. An inaccessible or missing attachment displays a placeholder, and private metadata is not used as a fallback. Metadata and file bytes use private/no-store responses.

Attachment metadata loads when a block approaches the viewport. Retry refreshes unavailable blocks; removal through the local attachments panel refreshes matching embedded blocks. Previously loaded previews are not remotely erased when a file or permission changes; subsequent requests are checked again. Reloading resolves the current state.

Removing a block preserves the underlying attachment and its use elsewhere. Deleting an attachment leaves an unavailable placeholder in existing document/history references. The block can be removed without removing other content. Read-only viewers can preview/download authorized files but cannot change descriptions or remove blocks.

Schema version 5 introduces image/file nodes; migration 17 updates new-document defaults and installs the shared reference check. Existing CRDT histories remain authoritative. Upgrade all app/collaboration replicas together and reload old editor tabs. Images/files are included by reference in JSON exports; portable export/import of their binary payloads remains unfinished.

Tests cover invalid IDs/labels, external source attributes, unsupported image formats, pending files, inaccessible references, rejected CRDT writes, restricted metadata/bytes, editability after deletion, actual upload/insertion, read-only previews/downloads, persistence, block removal and reuse of existing attachments. Screenshots in `.local/ui-review/editor-media.png` use test uploads.
