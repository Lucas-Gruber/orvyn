# Deployment

Use the [Helm and Rancher guide](infrastructure/helm/orvyn/README.md) for Kubernetes installation, values, Secrets, ingress, persistence and operational diagnostics. Production images run Web, API, Worker and Collaboration as non-root users. The chart also runs a separate configuration reconciler, which applies database migrations and deployment-managed OIDC without waiting for API or attachment readiness.

[Local development](DEVELOPMENT.md) uses Docker Compose infrastructure with native Node application processes. The [storage guide](docs/STORAGE.md) covers S3 and local filesystem attachments, private object ownership, shared volumes and migration boundaries. The [authentication guide](docs/AUTHENTICATION.md) covers local registration, profile names, exact OIDC issuers, legacy repair and configuration reconciliation.

Use matching chart/application versions and immutable release images. The development source is `0.3.0-dev.0`; published `0.2.0` images do not contain these development fixes. Building and pushing source does not publish a release. Production requires a public HTTPS origin, durable encryption key and database credentials, controlled migrations, private writable attachment storage, SMTP and verified backups.

Before upgrading, preserve the existing encryption key, Secrets, PVCs and database/attachment backups. Configuration reconciliation uses database locks and retries; it does not recreate claims or reset data. Configuration-value rollback is tested separately from application/schema downgrade. Older binaries may reject a newer database schema; verify compatibility or use the documented coordinated recovery procedure.

See [BACKUP.md](docs/BACKUP.md) for database archive and restore coverage and the remaining attachment/key/offsite backup requirements. Single-instance internal database, Valkey and storage modes are supported; HA, performance targets, disaster-recovery exercises and storage-vendor compatibility need their own validation. Test results and unavailable backends must be reported explicitly.
