# Security
Development-only release. Do not expose this application to the public Internet yet. Registration is open. Email verification, password reset, OIDC, session management and authentication audit events are implemented. Comprehensive hardening, penetration testing and organization policies are outstanding. Unverified local accounts can currently use their own private workspaces.

Passwords use salted scrypt. Browser sessions use HttpOnly/SameSite=Strict cookies, Secure when NODE_ENV=production. Mutations require the configured Origin and JSON. Auth attempts are limited per direct peer IP in PostgreSQL to 30 per 15 minutes; trusted proxy policy and proxy-aware identity and retention policies remain to be designed. Behind the current local web proxy users share its IP bucket. SQL values are parameterized. Private resources are scoped to their owner in SQL.

Never publish credentials or sensitive documents in public issue reports. Report vulnerabilities privately to the repository maintainers; a dedicated contact is not yet configured.

See docs/AUTHENTICATION.md for one-use tokens, encrypted outbox delivery, signed OIDC tokens, provider revocation and explicit remaining limitations.

Attachment storage is private by default and downloads are authorized through the API. HTML/SVG are not served inline. See docs/FILES.md for limits, lifecycle, preview behavior and remaining scanning/processing work, and docs/BACKUP.md for key handling and recovery limits.
