# Development

Requirements: Node >=22.12 (validated with 24.22.1), pnpm (validated with 11.25.0), Docker Compose, and Chromium for the browser test. The checked-in lockfile records the dependency versions.

For a local preview on your own computer, clone the repository and run:

```sh
pnpm install --frozen-lockfile
pnpm preview:local
```

Keep Docker Desktop running. The command prepares local configuration, starts the existing infrastructure, builds the application, checks storage/migrations and starts all four app services. When it prints `ORVYN_LOCAL_PREVIEW_READY`, open `http://localhost:5000` on that same computer. Create an account to try the application. Use `--port 5001` if 5000 is already occupied. Ctrl+C stops the app processes; infrastructure volumes and services are preserved. `--skip-setup` is intended for an already prepared checkout. The preview uses loopback-only web access and dynamically selected API/collaboration ports; it does not create a tunnel from the Cloud machine to your computer.

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

## Forwarded browser ports

The browser-facing port may differ from the Cloud server's listening port. For example, if your browser opens `http://localhost:5000` while the web service listens internally on 3000, set `ORVYN_ORIGIN=http://localhost:5000` in the ignored `.env` and leave `NUXT_PUBLIC_COLLABORATION_URL=` empty. Restart API, collaboration and web processes. Keep the internal API and collaboration addresses on ports 3001/3002.

The web service proxies authenticated WebSockets at `/collaboration` to private `NUXT_COLLABORATION_UPSTREAM` (default `ws://127.0.0.1:3002`). Only the web port needs forwarding; the browser derives `ws` or `wss` from its actual URL. The forwarding layer must support WebSocket upgrades. An explicit public collaboration override is still supported for other deployments. Both the proxy and upstream require the configured exact Origin; forwarded-host headers do not grant trust. Nitro's WebSocket support is enabled and integration-tested against the pinned Nuxt/Nitro versions.

## GitHub Codespaces browser preview

The checked-in `.devcontainer/devcontainer.json` uses the official Node 24 bookworm image with the Docker-in-Docker feature. Its creation hook installs pinned pnpm and the lockfile dependencies; its start hook waits for Docker and runs the full local preview preparation in the background. This requires no Docker installation on your computer. The default Codespaces machine is sufficient for this development stack; no larger machine is requested by this configuration.

From GitHub, open this repository, then Code → Codespaces → Create codespace on main. Wait for setup, then open forwarded port 5000 from the Ports tab. Its default private visibility is sufficient for the signed-in owner. Inspect `.local/codespaces-preview.log` if startup fails. Stop the codespace when finished; quota and billing depend on your GitHub account. This is a temporary development preview, not a production deployment.

The launcher derives the exact HTTPS origin from `CODESPACE_NAME` and `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` when `CODESPACES=true`. HTTPS previews set production cookie security; the internal API/collaboration addresses stay on dynamically selected local ports. You can explicitly set `ORVYN_PREVIEW_ORIGIN` for another configured HTTPS forwarding route. Remote plaintext origins and origins with credentials, paths or queries are rejected. This does not create a forwarding service by itself.

The official image manifest, development-container configuration, startup shell syntax, derived-origin handling, cookie security, app lifecycle and same-port collaboration are checked from this environment. GitHub-hosted codespace creation and its actual external URL cannot be exercised without starting a codespace in your account and remain unverified here.
