# orvyn.
Your knowledge. Organized.

Orvyn is an early implementation of a self-hosted collaborative workspace. **Not production ready.** The complete product specification is in [docs/PRODUCT.md](docs/PRODUCT.md).

Implemented: Nuxt web client, NestJS API, PostgreSQL persistence, local account lifecycle and SMTP email verification/password reset, session administration, administrator-configured OIDC, hashed cookie sessions, private/team spaces with verified invitations and inherited page permissions, hierarchical pages with trash/history, paragraph documents, explicit saves with optimistic concurrency control.

Start with [DEVELOPMENT.md](DEVELOPMENT.md). See [docs/STATUS.md](docs/STATUS.md) for the implementation boundary.

Authentication and remaining provider limitations: [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

Permission rules and current limits: [docs/PERMISSIONS.md](docs/PERMISSIONS.md).
