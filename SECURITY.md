# Security
Development-only release. Do not expose this application to the public Internet yet. Registration is open and email ownership is not verified. Password reset, OIDC, security audit logs, session administration and comprehensive hardening are outstanding.

Passwords use salted scrypt. Browser sessions use HttpOnly/SameSite=Strict cookies, Secure when NODE_ENV=production. Mutations require the configured Origin and JSON. Auth attempts are limited per direct peer IP in PostgreSQL to 30 per 15 minutes; trusted proxy policy and expiry cleanup remain to be designed. Behind the current local web proxy users share its IP bucket. SQL values are parameterized. Private resources are scoped to their owner in SQL.

Never publish credentials or sensitive documents in public issue reports. Report vulnerabilities privately to the repository maintainers; a dedicated contact is not yet configured.
