# Scoped agent access

Implements the first read-only slice of [#2](https://github.com/Lucas-Gruber/orvyn/issues/2). Orvyn's PostgreSQL documents and authoritative Yjs state remain the source of truth. This is a private integration API, not an anonymous publication, Git synchronization, MCP server, or an implemented agent write API.

## Credential lifecycle

Using an existing signed-in browser session, send `POST /api/v1/integrations/tokens` with the configured `Origin`, `Content-Type: application/json` and an explicitly reviewed body:

```json
{
  "label": "Shared instructions reader",
  "spaceId": "<space UUID>",
  "pageIds": ["<explicit document UUID>"],
  "expiresAt": "<UTC ISO timestamp within the next 30 days>",
  "confirm": true
}
```

The issuer must currently read every selected document. A token grants only `pages:read`, for 1–100 exact document/record IDs in one space. It does not grant descendants, a whole space, search, history, files, database values/views, people, comments, publication, account administration, or collaboration. Unknown fields and attempted write scopes are rejected. Scope and expiry are immutable; mint a replacement to change them. Each account may have at most 20 active tokens.

The response includes a random 256-bit `orvyn_agent_…` credential **once**. Only its SHA-256 digest is stored. Keep the value in the consuming agent's credential store or mounted secret; do not place it in a page, prompt, URL, Git repository, or generated instructions file. Use HTTPS outside local development. This feature supplies no token-management UI or automatic credential provisioning.

`GET /api/v1/integrations/tokens` lists the issuer's safe metadata and page IDs, with active tokens first and at most 100 entries including recent inactive history. It never returns a secret or digest. `DELETE /api/v1/integrations/tokens/:id` with JSON body `{}` revokes an owned credential; it uses the existing cookie/Origin/JSON mutation checks. Creation and revocation produce authentication audit events without copying the token or document body. Per-read audit telemetry is not implemented.

These credentials have their own expiry/revocation lifecycle. Ending browser sessions does not revoke them. Current ACL restrictions are checked on every read: loss of membership/access, ancestor restrictions or trash deny subsequent requests. Restored ACL access can permit a still-active credential again; explicitly revoke it for permanent invalidation. Requests already authorized before a revocation commits may complete, as with other HTTP reads.

## Reading current saved documents

Send `GET /api/v1/integrations/pages/:id` with `Authorization: Bearer <credential>`. This route accepts no browser-cookie or query-string substitute. Integration credentials are not accepted by existing API controllers or the collaboration service.

The result contains `source: "orvyn"`, the fixed scope, a projected `page` (`id`, `title`, `document`, `version`, `documentSchemaVersion`, `updatedAt`), `markdown`, and conversion `warnings`. If the separate Markdown conversion budget is exceeded, `markdown` is null and a warning directs the consumer to the structured document. `document` is the selected page's saved ProseMirror JSON projection; it can contain reference IDs and URLs authored inside that document. It does not expand references. Markdown also never dereferences another page, file, database or person's identity using the issuer's wider account access. Unsupported embedded resources therefore produce links/placeholders and warnings, rather than copied content or attachment bytes. The response is `Cache-Control: no-store`.

The SQL read intersects the token's exact page grants, original space, expiry and revocation with the issuer's **current** inherited page ACL in one statement. A malformed/missing credential returns 401. A syntactically valid but unavailable/expired/revoked token, ungranted page or inaccessible page returns the same 404. A newer document schema returns 409. This snapshot represents saved server state; unacknowledged browser edits are not a second authority.

Consumers may generate disposable local instructions/context from this API. Record the canonical Orvyn page ID/URL and fetched `version`, refresh at session start and before proposing a change, and clearly mark local output as a cache. Do not import local cache edits back automatically, replace canonical content with a stale export, or use Git as a competing source of truth. A client can compare fetched versions before refreshing its cache. A working cache generator, MCP adapter and runner deployment are outside this slice.

## Proposed write contract — not implemented

Existing `PUT /api/v1/pages/:id` continues to reject content replacement once `editor_documents` exists. No integration write scope or write endpoint is exposed. Supporting edits to a shared memory page requires a separately reviewed vertical slice:

1. Introduce a separate, explicit `pages:propose` grant and reviewed proposal endpoint. Carry the source page ID, saved version, Yjs state vector, bounded proposed operation(s), request UUID, author identity and expiry. Store proposals separately; creating one must not alter page content or grant wider rights. A bare Markdown snapshot is not a safe CRDT operation.
2. Show a current Orvyn diff/review. Bind approval to the exact proposal digest, current document/permission state and approver. A stale base or changed access requires a fresh review; never silently overwrite or force a stale version. The UI and operation model need design and tests before this contract becomes an API promise.
3. Apply accepted operations through the authoritative collaboration persistence path: current identity and exact scope, current Editor access, session/token plus shared-space and per-document locks, load/merge the persisted Y.Doc, enforce schema/asset/reference limits, and atomically persist Yjs state, page projection, revision and audit identity. Broadcast through the existing coordination mechanism and acknowledge only durable commits. Do not update `pages.document` independently or delete/reinitialize `editor_documents`.
4. Use the request UUID and reviewed digest for idempotent lost-response retries. Recheck expiry, revocation and ACL at application time. Exercise simultaneous human edits, multi-replica delivery, stale reviews, membership loss, durable acknowledgements, rollback and retry against real PostgreSQL/Yjs before exposing the capability.

These are follow-up requirements, not shipped behavior or security guarantees for an absent write API. Scoped reads can support both agents today after an authorized installation; reviewed collaborative writes remain a separate implementation.

## Validation

`tests/integrations.test.mjs` runs against the real API and disposable PostgreSQL through the existing integration runner. It covers exact page grants, current canonical versions, reference isolation, token digest storage, one-time disclosure, cookie/Bearer separation, invalid scope/expiry/origin, ownership, revocation, expiry, inherited ACL/membership/trash, audit events, and the existing collaboration 409 guard. It is included in `scripts/test.mjs`; it does not require user data or production credentials.
