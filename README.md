# orvyn.
Your knowledge. Organized.

Orvyn is an early implementation of a self-hosted collaborative workspace. **Not production ready.** The complete product specification is in [docs/PRODUCT.md](docs/PRODUCT.md).

Implemented: Nuxt web client, NestJS API, PostgreSQL persistence, local account lifecycle and SMTP email verification/password reset, session administration, administrator-configured OIDC, hashed cookie sessions, private/team spaces with verified invitations and inherited page permissions, hierarchical pages with trash/history, a shared Tiptap editor with durable Yjs collaboration, live carets, Redis replica coordination and optimistic title updates.

Start with [DEVELOPMENT.md](DEVELOPMENT.md). See [docs/STATUS.md](docs/STATUS.md) for the implementation boundary.

Authentication and remaining provider limitations: [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

Permission rules and current limits: [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

Editor, replicas and tested limits: [docs/COLLABORATION.md](docs/COLLABORATION.md).

Private attachments: [docs/FILES.md](docs/FILES.md). Recovery evidence and remaining limits: [docs/BACKUP.md](docs/BACKUP.md).
