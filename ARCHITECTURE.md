# Architecture
## ADR 001: First persistent vertical slice
Accepted: pnpm workspaces, Nuxt 4.6.4/Vue 3.5.45 for web, NestJS 12.5.0 for the API, pg 8.23.1 and PostgreSQL 17. Registry versions were checked during implementation; the lockfile records the resolved graph. Node 24 meets the requested >=22 baseline.

The browser uses same-origin /api/v1 requests through Nitro. PostgreSQL is authoritative. Session tokens are random 256-bit values; only SHA-256 digests are stored. Passwords use salted scrypt. Ownership is enforced inside each resource SQL query. No public sharing endpoint exists. Document updates compare an integer revision and reject stale writes.

Tables: users, sessions, spaces, pages, auth_limits, schema_migrations. Documents currently use `{type:"doc", content:[{type:"paragraph", text:"..."}]}`. This is a preliminary paragraph schema, not Tiptap or Yjs. No compatibility with future CRDT state is claimed.

Auth, spaces, pages and health have separate Nest modules. Database and request-security helpers are shared in runtime.ts; domain services and repositories should be extracted as these modules grow. Team membership, hierarchical permissions, collaboration persistence and schema migration policies need their own ADRs before implementation. Do not substitute owner checks for the final permissions model.
