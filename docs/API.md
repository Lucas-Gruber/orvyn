# API v1
All routes use /api/v1. Responses are JSON. Authentication uses the orvyn_session cookie. POST/PUT require application/json and Origin equal to ORVYN_ORIGIN. Errors include a message and HTTP status. OpenAPI generation is not implemented yet.

| Method | Route | Body / result |
|---|---|---|
| GET | /health | Database-backed health |
| POST | /auth/register | email, password (12–256 characters); creates account and session |
| POST | /auth/login | email, password; new session |
| POST | /auth/logout | {}; invalidates current session |
| GET | /spaces | Owner's id/name list |
| POST | /spaces | name; private owner-only space |
| GET | /spaces/:id/pages | Owner-authorized page list |
| POST | /spaces/:id/pages | title; creates paragraph document |
| PUT | /pages/:id | title, document, version; updates and increments version |

Unavailable or stale writes return 409; reload and reconcile before retrying. No public access or team permissions exist.

Additional authenticated routes:

| Method | Route | Operation |
| --- | --- | --- |
| GET | /auth/me | Current account, email verification and admin flag |
| GET | /auth/sessions | Current user's active session metadata |
| DELETE | /auth/sessions/:id | Revoke an owned session |
| POST | /auth/logout-all | Revoke every owned session |
| POST | /auth/request-verification | Queue verification email |
| POST | /auth/verify-email | Consume token |
| POST | /auth/request-password-reset | Queue reset email, generic response |
| POST | /auth/reset-password | Consume token and new password; revoke sessions |
| GET | /oidc/providers | Enabled provider display names |
| POST | /oidc/:id/start | Browser-bound PKCE authorization URL |
| GET | /oidc/:id/callback | Verify authorization response and issue session |
| GET/POST | /admin/oidc/providers | Administrator configuration |
| PUT | /admin/oidc/providers/:id | Update settings/secret/enablement |
| GET | /spaces/:id/team-preview | Owner-only privacy preview |
| POST | /spaces/:id/convert-to-team | Confirm current preview version |
| GET | /spaces/:id/members | Owner/admin member management |
| POST | /spaces/:id/invitations | Email a role-scoped invitation |
| POST | /spaces/invitations/accept | Accept with matching verified identity |
| PUT/DELETE | /spaces/:id/members/:member | Change role or revoke membership |
| GET | /pages/:id | Authorized page |
| GET/PUT | /pages/:id/permissions | Inherited restrictions and explicit grants |
| POST | /pages/:id/move | Move within a space, preserving previous audience |
| DELETE | /pages/:id | Soft delete; confirm=true for a hierarchy |
| GET | /spaces/:id/trash | Authorized deleted roots |
| POST | /pages/:id/restore | Restore an accessible deleted page |
| GET | /pages/:id/history | Authorized content revision metadata |
| GET | /pages/:id/history/:version | Authorized saved revision |

Page creation accepts parentId. Page listing accepts q, after and limit (1–200) and exposes X-Next-Cursor when more records exist. Direct inaccessible resources return 404; stale versions return 409. See docs/PERMISSIONS.md for inheritance and conversion semantics.

PATCH /pages/:id/title accepts title and titleVersion. REST content updates normalize legacy paragraph input but reject replacements once editor_documents contains a CRDT for the page. Use the authenticated collaboration service for subsequent content changes.

File routes: GET /files/limits; GET/POST /pages/:id/files (POST is authenticated multipart/form-data with one file field, Origin required); GET /files/:id/download; GET /files/:id/preview for detected raster images; DELETE /files/:id with JSON body. All file resources inherit page permissions.

Database routes: GET/POST /spaces/:id/databases; GET /databases/:id; POST /databases/:id/properties; PATCH /databases/:id/properties/:property (name, schemaVersion); POST /databases/:id/views; PATCH /databases/:id/views/:view (version plus view settings); POST /databases/:id/query (200, typed filters/sorts/search/pagination); POST /databases/:id/records (title, values, optional visibility); PATCH /databases/:id/records/:record (version, partial values). Opening/editing record documents uses the ordinary page APIs. GET /spaces/:id/directory provides a member-scoped identity directory for account selectors.

Database transfer routes (all authenticated):
- `POST /api/v1/databases/:id/import/csv/preview`: exact Origin, write access, multipart `file` and optional JSON `settings` (`mapping`, `allowNewOptions`). Returns headers, first 20 raw rows, mapping, proposed properties/options, validation errors and an actor-bound token if valid.
- `POST /api/v1/databases/:id/import/csv/confirm`: same multipart file and JSON `settings: {token}`; atomic creation, schema conflict 409, idempotent retry 200.
- `GET /api/v1/databases/:id/export.csv`: authorized attachment download; optional `viewId`, `spreadsheetSafe=true` default.
- `GET /api/v1/databases/:id/export.json`: exact typed values, schema/views/documents and attachment metadata; optional `viewId`.
