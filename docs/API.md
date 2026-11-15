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
