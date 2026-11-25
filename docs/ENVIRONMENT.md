# Environment variables

| Variable                                           | Purpose                                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                                       | PostgreSQL URL including TLS parameters; secret. Takes precedence over split PG fields.                                                                   |
| PGHOST / PGPORT / PGUSER / PGDATABASE / PGPASSWORD | Alternative database configuration for existing password Secrets; port defaults to 5432. API, Worker and Collaboration share these fields.                |
| ORVYN_DB_PASSWORD                                  | Local Compose password, matching DATABASE_URL; secret.                                                                                                    |
| ORVYN_ENCRYPTION_KEY                               | Required 32-byte hex encryption key for provider secrets and mail outbox; keep stable, back up securely, share across replicas.                           |
| ORVYN_ORIGIN                                       | Exact public origin, required in production for Web, API, Worker and Collaboration. Production requires HTTPS; the localhost default is development-only. |
| NUXT_API_URL                                       | Private Nuxt API upstream, required explicitly in production. Development default http://127.0.0.1:3001.                                                  |
| ORVYN_LOG_LEVEL                                    | debug, info (default), warn or error. Structured diagnostics exclude raw error payloads, passwords, connection strings and tokens.                        |
| SMTP_URL                                           | SMTP transport URL for the email worker; may contain credentials.                                                                                         |
| MAIL_FROM                                          | Sender address; default orvyn@localhost.test for local development.                                                                                       |
| PORT                                               | API port; default 3001.                                                                                                                                   |
| NODE_ENV                                           | production enables Secure cookies; HTTPS required.                                                                                                        |
| ORVYN_OIDC_ALLOW_HTTP_LOCAL                        | Explicit development-only loopback HTTP issuer support; ignored in production. Test runner enables it only for isolated child processes.                  |
| CHROMIUM_PATH                                      | Browser test executable; default /usr/bin/chromium.                                                                                                       |
| TEST_URL / TEST_ORIGIN                             | Isolated runner's frontend URL and expected Origin.                                                                                                       |
| TEST_MAIL_URL                                      | Local test mailbox; default http://127.0.0.1:8025.                                                                                                        |

| REDIS_URL | External Redis/Valkey coordination URL, including rediss:// TLS and optional credentials. Takes precedence over split fields. |
| VALKEY_HOST / VALKEY_PORT / VALKEY_PASSWORD | Internal Valkey alternative used by the Helm chart; port defaults to 6379. |
| COLLABORATION_PORT | Collaboration service port, default 3002. |
| COLLABORATION_NAMESPACE | Shared Redis key namespace; use one value per deployment. |
| NUXT_PUBLIC_COLLABORATION_URL | Optional browser WebSocket override; leave empty to use the browser origin with /collaboration (including forwarded ports and HTTPS/WSS). |

| NUXT_COLLABORATION_UPSTREAM | Private Nuxt WebSocket upstream, required explicitly in production. Development default ws://127.0.0.1:3002. Never point this at the public /collaboration route itself. |

## Attachments and deployment SSO

`ORVYN_STORAGE_DRIVER` defaults to `s3` when absent; `local` requires an absolute private `ORVYN_STORAGE_LOCAL_PATH` shared by API and Worker. S3 uses `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Changing drivers does not copy existing objects. See [STORAGE.md](STORAGE.md).

Deployment OIDC uses `ORVYN_OIDC_ENABLED`, `NAME`, `ISSUER`, `CLIENT_ID`, `CLIENT_SECRET`, `CLIENT_AUTH_METHOD`, `SCOPES`, `AUTO_PROVISION`, and optional `ADMIN_SUBJECT` (each with the `ORVYN_OIDC_` prefix). Issuers are exact strings: preserve trailing slashes from discovery metadata. `ORVYN_OIDC_REPAIR_LEGACY_ISSUER=false` controls explicit approval to repair legacy normalization when linked accounts exist; see the migration rules in [AUTHENTICATION.md](AUTHENTICATION.md). `ORVYN_OIDC_BOOTSTRAP_MODE=auto` applies configuration on API startup; Helm uses `external` and a dedicated compiled configuration command, keeping the client secret out of API pods. `NODE_EXTRA_CA_CERTS` can reference a mounted private IdP CA. The [Helm chart](../infrastructure/helm/orvyn/README.md) provides a dedicated SSO form section.
