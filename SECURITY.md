# Security

Orvyn is an early-access server release. Email verification, password reset, OIDC, session management and authentication audit events are implemented. Comprehensive hardening, penetration testing and organization policies are outstanding. Unverified local accounts can currently use their own private workspaces.

The 0.3.0 development source adds `ORVYN_REGISTRATION_ENABLED=false` to disable local self-registration and `ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS` to limit new local accounts to exact domains. Helm/Rancher expose the same controls. Default signup remains open for compatibility; establish administrator access before closing it. Existing sign-in/recovery and provider-controlled OIDC provisioning remain available. Public `/api/v1/auth/options` reveals only the registration rule, including any configured domain list. See [AUTHENTICATION.md](docs/AUTHENTICATION.md) for semantics and the published 0.2.0 boundary.

Passwords use salted scrypt. Browser sessions use HttpOnly/SameSite=Strict cookies, Secure when NODE_ENV=production. Mutations require the configured Origin and JSON. Credential attempts are limited in PostgreSQL to 500 per direct peer, 30 per account/peer pair and 100 per account in each 15-minute window; trusted proxy policy and proxy-aware identity and retention policies remain to be designed. Behind the current web proxy users share its IP bucket. SQL values are parameterized. Private resources use current space membership and inherited page restrictions on the server.

Never publish credentials or sensitive documents in public issue reports. Report vulnerabilities privately to the repository maintainers; a dedicated contact is not yet configured.

See docs/AUTHENTICATION.md for one-use tokens, encrypted outbox delivery, signed OIDC tokens, provider revocation and explicit remaining limitations.

Attachment storage is private by default and downloads are authorized through the API. HTML/SVG are not served inline. See docs/FILES.md for limits, lifecycle, preview behavior and remaining scanning/processing work, and docs/BACKUP.md for key handling and recovery limits.
