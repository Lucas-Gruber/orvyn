# Editor and collaboration

## ADR 004: Shared schema and durable Yjs updates

The MIT-licensed Tiptap 3.34.0 and Yjs 13.6.33 form the shared editor package. Hocuspocus 4.8.0 server/provider and Redis extension are MIT licensed; their current registry licenses and Node >=22 compatibility were checked. No proprietary Tiptap extensions are used. The workspace uses ESM consistently to avoid separate CommonJS/ESM copies of ProseMirror and Yjs.

`packages/editor` defines schema version 6 and both client/server extensions: paragraphs, headings 1–3 with permanent anchors, bold/italic/underline/strike/link marks, lists, nested checklists, quotes, code blocks, dividers, tables, linked databases, callouts, collapsible sections dynamic tables of contents private attachment references and document preview cards. JSON and CRDT updates are schema-validated and bounded. Links cannot use executable/data protocols; node count, nesting, heading levels, anchor identities and table spans are constrained. Migration 6 upgrades legacy paragraph JSON and retained revisions without discarding text. Versions 2 and 3 add linked database references and heading identities respectively; version 4 adds the structured blocks described in EDITOR_BLOCKS.md. See [DOCUMENT_LINKS.md](DOCUMENT_LINKS.md) for legacy heading handling and linking behavior.

The client provides a formatting toolbar, keyboard-accessible slash menu, Markdown shortcuts, collaborative undo/redo, live carets, authenticated presence and automatic saving. Offline editing is disabled in the UI; loss of connectivity or permission pauses editing. Persistent browser offline storage, multi-block selection/dragging, embeds, columns and other full-spec blocks remain outstanding.

## Authentication and authorization

WebSockets use the HttpOnly session cookie, never a copied browser token. Origin must exactly match ORVYN_ORIGIN. Document rooms are page UUIDs. API and collaboration share the session authentication package and PostgreSQL orvyn_page_role policy.

Each input rechecks authentication; document writes recheck access under database locks. Viewer connections are read-only. Presence identity/color is rewritten server-side and a client cannot replace another account's awareness state. Active connections are revalidated every 500 ms, and every outgoing data frame is queued behind a fresh permission check while holding the session/space locks used by revocation. This includes initial presence. Closing a room discards queued data. Outbound queues have count/byte limits.

Hocuspocus exposes synchronous connection sends; the service wraps its public Document.addConnection and Connection.send methods to install the asynchronous authorization queue before initial awareness is sent. The Hocuspocus version is pinned and this integration must be retested when upgrading.

## Persistence and replicas

PostgreSQL stores the authoritative editor_documents Yjs state, a structured JSON projection on pages and immutable content revisions. Accepted updates merge into the persisted CRDT under a per-document advisory lock and transaction before Hocuspocus applies/acknowledges them. This serializes initial creation across replicas and prevents conflicting initial histories. Structural/permission writes lock the space exclusively; document-only updates use shared space locks and do not invalidate the team-conversion preview.

Redis distributes document and presence updates across replicas; it is not the durable document store. The Redis extension's store lock is disabled because persistence occurs before every accepted sync update, rather than overwriting snapshots on debounce. If coordination is lost, the process closes connections, becomes unready and exits so an orchestrator can restart it. Durable state is recovered from PostgreSQL. No distributed availability or performance target has been established yet.

Once a page has a CRDT, REST content replacement is rejected to prevent competing state authorities. Page titles use a separate optimistic title revision and PATCH endpoint. Space/page permissions remain outside Yjs and are always enforced server-side.

## Development and validation

Run `pnpm dev:collaboration` after building shared packages. Redis is provided by local Compose. NUXT_PUBLIC_COLLABORATION_URL defaults to the generated local ws://localhost:3002 setting; production should route the /collaboration WebSocket path through a TLS ingress or provide an explicit wss URL. All replicas use the same DATABASE_URL, REDIS_URL and COLLABORATION_NAMESPACE.

The isolated test runner starts two collaboration processes. Tests cover cross-replica simultaneous edits, durable acknowledgements, read-only enforcement, authenticated presence, disconnect/reconnect, membership revocation, rejected cross-origin/unauthenticated connections and recovery in a new process with an independent Redis namespace. A TCP interruption fixture verifies fail-closed behavior when Redis is lost. Chromium tests exercise the real editor and reload its persisted content.

Comments, mentions, operational multi-replica stress tests, deployment-level TLS/ingress validation and production recovery procedures remain outstanding.
