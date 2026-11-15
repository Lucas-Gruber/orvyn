# Development

Requirements: Node >=22.12 (validated with 24.22.1), pnpm (validated with 11.25.0), Docker Compose, and Chromium for the browser test. The checked-in lockfile records the dependency versions.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm infra:up
pnpm build
pnpm storage:init
pnpm dev:api
# separate terminals, same working directory:
pnpm dev:worker
pnpm dev:collaboration
pnpm dev:web
```

`setup:local` preserves existing .env values, generates random missing local database/encryption credentials, and supplies local SMTP defaults. Never commit .env or print its contents. For cloud machines with a read-only home, prefix pnpm installation with `XDG_DATA_HOME=/workspace/.local/share XDG_CACHE_HOME=/workspace/.cache` and append `--store-dir /workspace/.pnpm-store`.

The web server uses port 3000 and proxies /api to the API on 3001. Mutations require the exact ORVYN_ORIGIN; default is http://localhost:3000. Configure ORVYN_ORIGIN and restart the API for another hostname. NUXT_API_URL can override the web server's upstream API at runtime. No tokens are stored in browser localStorage.

```sh
pnpm typecheck
pnpm test
```

The test runner creates its own temporary database, API, worker and Nuxt processes against the local PostgreSQL/Redis/S3/Mailpit services. It exercises both the proxy and real Chromium. PostgreSQL credentials must be able to create/drop test databases on the **local development instance**. Database names are randomized and the runner drops only its own database. Remote database URLs are rejected. Tests never intentionally remove your application database or volumes. CHROMIUM_PATH overrides /usr/bin/chromium.

`pnpm db:migrate` applies versioned migrations after a build. API startup also applies them atomically under a PostgreSQL advisory lock. Upgrade, concurrent execution, data preservation and failed-migration rollback are covered by tests.

Stop infrastructure with `docker compose --env-file .env -f infrastructure/compose/compose.yaml stop`. Do not remove volumes containing useful data. See docs/AUTHENTICATION.md for SMTP, OIDC and administrator bootstrap.

Shared packages must be built before starting development processes. Collaboration health runs on port 3002; do not assume live processes survive environment snapshots. For another browser origin, update both ORVYN_ORIGIN and NUXT_PUBLIC_COLLABORATION_URL.

S3 credentials and the local identity file are generated without printing values. Do not delete .local/s3.json or .env while retaining storage data unless you have preserved their configuration securely. Storage initialization verifies anonymous rejection. The test runner creates its own S3 bucket and restores a separate database/bucket for recovery checks.
