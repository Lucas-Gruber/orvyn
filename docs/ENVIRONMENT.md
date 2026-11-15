# Environment variables

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | Required PostgreSQL URL; secret. |
| ORVYN_DB_PASSWORD | Local Compose password, matching DATABASE_URL; secret. |
| ORVYN_ENCRYPTION_KEY | Required 32-byte hex encryption key for provider secrets and mail outbox; keep stable, back up securely, share across replicas. |
| ORVYN_ORIGIN | Exact permitted browser origin and OIDC redirect origin; default http://localhost:3000. |
| NUXT_API_URL | Nuxt runtime upstream API; default http://127.0.0.1:3001. |
| SMTP_URL | SMTP transport URL for the email worker; may contain credentials. |
| MAIL_FROM | Sender address; default orvyn@localhost.test for local development. |
| PORT | API port; default 3001. |
| NODE_ENV | production enables Secure cookies; HTTPS required. |
| ORVYN_OIDC_ALLOW_HTTP_LOCAL | Explicit development-only loopback HTTP issuer support; ignored in production. Test runner enables it only for isolated child processes. |
| CHROMIUM_PATH | Browser test executable; default /usr/bin/chromium. |
| TEST_URL / TEST_ORIGIN | Isolated runner's frontend URL and expected Origin. |
| TEST_MAIL_URL | Local test mailbox; default http://127.0.0.1:8025. |

| REDIS_URL | Redis coordination URL; may include credentials; required by collaboration. |
| COLLABORATION_PORT | Collaboration service port, default 3002. |
| COLLABORATION_NAMESPACE | Shared Redis key namespace; use one value per deployment. |
| NUXT_PUBLIC_COLLABORATION_URL | Browser WebSocket endpoint; local setup supplies ws://localhost:3002; use wss in production. |
