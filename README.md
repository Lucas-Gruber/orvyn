# orvyn.
Your knowledge. Organized.

Orvyn is an early implementation of a self-hosted collaborative workspace. **Not production ready.** The complete product specification is in [docs/PRODUCT.md](docs/PRODUCT.md).

Implemented: Nuxt web client, NestJS API, PostgreSQL persistence, local account lifecycle and SMTP email verification/password reset, session administration, administrator-configured OIDC, hashed cookie sessions, private/team spaces with verified invitations and inherited page permissions, hierarchical pages with trash/history, a shared Tiptap editor with durable Yjs collaboration, live carets, Redis replica coordination and optimistic title updates.

To view it **on your own computer**, install Node >=22.12, pnpm and Docker Desktop, clone this repository, then run `pnpm install --frozen-lockfile` and `pnpm preview:local`. When `ORVYN_LOCAL_PREVIEW_READY` appears, open `http://localhost:5000` on that same computer. This command does not forward a Cloud environment to your computer.

Start with [DEVELOPMENT.md](DEVELOPMENT.md). See [docs/STATUS.md](docs/STATUS.md) for the implementation boundary.

Authentication and remaining provider limitations: [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

Permission rules and current limits: [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

Editor, replicas and tested limits: [docs/COLLABORATION.md](docs/COLLABORATION.md).

Private attachments: [docs/FILES.md](docs/FILES.md). Recovery evidence and remaining limits: [docs/BACKUP.md](docs/BACKUP.md).

Structured databases and tested view behavior: [docs/DATABASES.md](docs/DATABASES.md).
