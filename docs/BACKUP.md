# Backup and recovery

Orvyn requires coordinated protection of PostgreSQL, object storage and ORVYN_ENCRYPTION_KEY. Redis contains coordination state; the durable collaborative document is in PostgreSQL and does not require a Redis dump. Live processes and sessions in browser memory are not a backup.

## Local PostgreSQL helpers

After local setup, from the repository root:

```sh
pnpm backup:db backups/orvyn.dump
pnpm restore:db backups/orvyn.dump orvyn_restore_recovery
```

The helpers target the local development Compose PostgreSQL container through the managed Unix Docker socket. They use the container's matching pg_dump/pg_restore tools. Archives use custom format and mode 0600. Backup refuses to overwrite an existing file. Restore creates a new database only, requires the orvyn_restore_ prefix, uses a single transaction and refuses existing databases. A failed restore removes only the new database it created. It never drops the source database. These Linux development helpers are not a managed production backup service.

Keep archives private and encrypted outside the development machine. The database contains document content and sensitive account metadata even though passwords/tokens are hashed and provider secrets/outbox payloads are encrypted. Back up the encryption key separately through a secure mechanism; it is not copied into archives by these helpers.

## Object storage

A database archive alone cannot recover attachment bytes. Back up the S3 objects with their keys unchanged, including objects retained after logical deletion. Use the storage provider's supported backup/replication/versioning tools. Coordinate the database backup with the worker's object-deletion retention window, and stop writes/cleanup or use an appropriate snapshot/versioning strategy for a consistent production backup. Do not assume a live copy across changing services is transactionally consistent.

For recovery into a new installation: restore PostgreSQL, restore the corresponding immutable object keys into a private bucket, restore the encryption key, configure the new database/bucket endpoints, run the version-appropriate migrations, start API/worker/collaboration/web, and check private pages, attachments and collaboration state. Restore access policies and network/TLS configuration too.

## Automated evidence and limits

An integration test exports PostgreSQL, restores into a new database, copies the restored metadata's retained object keys into an independent S3 bucket, starts another API process, and verifies page content, exact attachment bytes and unauthenticated denial. It also verifies refusal to overwrite an existing database. Another test loads a persisted Yjs document in a new collaboration process with an independent Redis namespace.

This validates an isolated recovery path on Linux. Scheduled backups, encrypted offsite archives, production point-in-time recovery, large-data restore timing, object-store-native restore and a Kubernetes disaster-recovery exercise remain outstanding. No RPO/RTO is promised.

## Native filesystem attachments

Database-only development dump/restore commands remain unchanged. For native local attachment storage, back up the entire private `orvyn-objects` directory or its PVC together with a coordinated PostgreSQL backup and the persistent encryption key. Preserve ownership and mode bits, restore into an empty private directory, and mount the same restored data into API and Worker. Validate authenticated downloads, template copies, exports and retention on a restored staging instance before allowing writes. See [STORAGE.md](STORAGE.md) and the [Helm operational notes](../infrastructure/helm/orvyn/README.md). Switching the driver is not a data migration.
