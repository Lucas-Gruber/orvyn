# Development
Requirements: Node >=22 (validated with 24.22.1), pnpm (validated with 11.25.0), Docker Compose.

From the repository root:
```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm infra:up
pnpm dev:api
# separate terminal, same working directory:
pnpm dev:web
```
`setup:local` preserves an existing .env; otherwise it generates a random local database password. Never commit .env. For cloud machines with a read-only home, prefix pnpm installation with `XDG_DATA_HOME=/workspace/.local/share XDG_CACHE_HOME=/workspace/.cache` and append `--store-dir /workspace/.pnpm-store`.

Web uses port 3000 and proxies /api to the API on 3001. Mutations require the exact ORVYN_ORIGIN; default is http://localhost:3000. For another hostname configure ORVYN_ORIGIN and restart API. No tokens are stored in browser localStorage.

```sh
pnpm build
# With database and both servers running:
pnpm test
```
Tests create isolated accounts and retained test data. Use a disposable development database. They test the real web proxy, API and PostgreSQL, not mocks.

Stop infrastructure with `docker compose --env-file .env -f infrastructure/compose/compose.yaml stop`. Do not remove volumes containing useful data. Schema version 1 is installed atomically at API startup; later migrations require an explicit migration runner.
