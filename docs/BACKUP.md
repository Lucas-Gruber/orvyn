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

## Scheduled PostgreSQL snapshots on Kubernetes

The development chart adds an opt-in `backup` section (not included in the published 0.2.0 chart). Merge [examples/database-backup.yaml](../infrastructure/helm/orvyn/examples/database-backup.yaml) into your installation values. Rancher exposes these settings under **Database backups**. The default schedule is daily at **02:17 UTC**, retaining **seven completed snapshots** on a separate retained 20 GiB PVC. Select an existing claim or a suitable StorageClass for your environment. `backup.suspend=true` pauses scheduled runs; manual Jobs still work.

The CronJob uses the chart's PostgreSQL credentials, never attachment, SMTP, OIDC or encryption secrets. The pinned PostgreSQL 17 client matches the bundled database. For an external database, select a compatible client image using `backup.image.repository/tag/digest`; a nonempty digest takes precedence over the tag. Prefer the same major version as the source and recovery server. Standard libpq URI TLS parameters are preserved; `backup.ca.existingSecret` and `secretKey` optionally mount a private CA as `PGSSLROOTCERT`. URI `sslrootcert` parameters take precedence over that environment setting, so omit conflicting paths from the URI.

Each run takes a transactionally consistent `pg_dump` custom-format database snapshot, checks its archive index, writes metadata and SHA-256 checksums, syncs the files, and publishes the completed directory through a same-filesystem rename. Failed dumps are not published. Directories have mode 0700 and archives mode 0600. Both scheduled and manual runs acquire a filesystem lock; the CronJob also uses `concurrencyPolicy: Forbid`, bounded execution time and no automatic retry by default. Retention starts only after a new snapshot verifies and keeps the new snapshot even if the host clock moves backward. Unrelated directories, symlinks and abandoned partial directories are excluded from retention.

Snapshots live at `/backups/<chart-fullname>/postgresql/postgresql-<UTC timestamp>-<random suffix>/` and contain `database.dump`, `metadata` and `SHA256SUMS`. The PVC must provide POSIX permissions, advisory locks, atomic directory rename and file syncing. Keep the configured UID/GID consistent across upgrades. The default non-root identity is 999:999. All jobs sharing an existing claim must honor the lock. Size the claim for at least the retained snapshots **plus one new dump**; inspect job failures and available capacity. Partial directories left by an abrupt node/pod loss can be removed only after confirming no job still uses them.

These are **database-only, unencrypted local-volume snapshots**, not a complete disaster-recovery system. The database dump contains private content and encrypted account/provider payloads. Use storage encryption and protect access to the PVC. Arrange encrypted offsite copies, coordinated attachment backups and separate key/Secret protection. Garbage-collected attachment objects can disappear after an earlier database snapshot; copying today's files is not equivalent to restoring that snapshot. No application writes or cleanup are paused automatically. An archive index/checksum check does not replace a restore drill.

### Trigger a backup

For a Helm release named `orvyn` in namespace `orvyn`, without name overrides:

```sh
kubectl create job --namespace orvyn \
  --from=cronjob/orvyn-orvyn-db-backup orvyn-backup-manual
kubectl wait --namespace orvyn --for=condition=complete \
  job/orvyn-backup-manual --timeout=30m
kubectl logs --namespace orvyn job/orvyn-backup-manual
```

The completion log prints the exact snapshot name without connection credentials. Choose a fresh Job name for subsequent runs. For failed Jobs inspect their status/events and generic diagnostics; never post credentials or archive contents in issues. The scripts intentionally suppress raw PostgreSQL error output, which can include credential-bearing connection strings. A Job with a failed condition will not satisfy the completion wait; cancel that wait and inspect the failure. Application and backup PVCs survive a normal Helm uninstall by default, but deleting the namespace or underlying storage can still remove them.

### Restore a snapshot into a new database

Use only trusted archives: checksums detect corruption, not malicious SQL or provenance. The recovery database server needs compatible locale/encoding, PostgreSQL extensions and client/server versions. The connecting role needs `CREATEDB` and permission to restore the archived objects. The tool deliberately refuses to replace any existing database.

First derive a one-off Job from the installed CronJob so it keeps the correct image, selected database Secret, CA, scripts, private PVC and security settings:

```sh
kubectl create job --namespace orvyn \
  --from=cronjob/orvyn-orvyn-db-backup orvyn-restore-drill \
  --dry-run=client --output=yaml > restore-job.yaml
```

In `spec.template.spec.containers[0]`, replace `command` and append these two variables to the existing `env` list. Replace the snapshot placeholder with the exact name printed by a successful backup; keep the database connection variables and other settings:

```yaml
command: [/bin/bash, /scripts/restore-postgresql.sh]
env:
  # Keep the generated PG* or DATABASE_URL entries and ORVYN_BACKUP_DIRECTORY.
  - name: ORVYN_RESTORE_BACKUP
    value: REPLACE_WITH_COMPLETED_SNAPSHOT_NAME
  - name: ORVYN_RESTORE_DATABASE
    value: orvyn_restore_drill
```

The database name must start with `orvyn_restore_`, contain only lowercase ASCII letters, digits and underscores, and fit PostgreSQL's 63-byte name limit. Keep the PVC writable for its shared lock; the restore tool reads the archives without modifying them. Review the Job's deadline for your data size, then:

```sh
kubectl create --filename restore-job.yaml
kubectl wait --namespace orvyn --for=condition=complete \
  job/orvyn-restore-drill --timeout=30m
kubectl logs --namespace orvyn job/orvyn-restore-drill
```

The tool verifies the selected archive and checksum manifest before creating a fresh database, confirms the connection points to that exact new database, and restores with a single transaction. It checks the required Orvyn tables and removes only its newly created database on a detected restore failure. Abrupt node loss/SIGKILL may leave an incomplete new database for manual inspection; it never authorizes deletion of a pre-existing database. Failed checks or an existing target leave the source database intact.

The Job does **not** switch running services to the recovered database. For a full drill, restore the corresponding attachments into independent private storage, provide the original encryption key, then start an isolated Orvyn installation against that recovered set. A snapshot also restores old sessions, tokens, grants and pending mail; revoke restored authentication state and review permissions and mail delivery before opening a recovered installation to users. Verify private downloads, OIDC configuration, collaborative documents and worker behavior before a planned cutover. Delete only the disposable recovery database when finished; keep the live installation and its retained backups.

## Automated evidence and limits

An integration test exports PostgreSQL, restores into a new database, copies the restored metadata's retained object keys into an independent S3 bucket, starts another API process, and verifies page content, exact attachment bytes and unauthenticated denial. It also verifies refusal to overwrite an existing database. Another test loads a persisted Yjs document in a new collaboration process with an independent Redis namespace.

`tests/postgresql-backups.test.mjs` executes the chart's actual Bash scripts as UID 999 against PostgreSQL. It checks internal and URI connections, real archive/restore, private modes, bounded retention, manual-job locking, existing-target refusal, truncated archives, forged checksum paths, failed-restore cleanup and source-data preservation. Helm checks cover internal/external databases, local/S3 attachments, GitOps, an existing backup claim and a private database CA. The Kubernetes check now includes a real backup Job from the CronJob and a new-database restore Job using the same PVC; inspect the current CI run before treating that new cluster check as passed.

Scheduled PostgreSQL snapshots are implemented in the development chart. Coordinated scheduled attachment/key backups, encrypted offsite archives, production point-in-time recovery, large-data restore timing, object-store-native restore and a complete Kubernetes disaster-recovery exercise remain outstanding. No RPO/RTO is promised.

## Native filesystem attachments

Database-only development dump/restore commands remain unchanged. For native local attachment storage, back up the entire private `orvyn-objects` directory or its PVC together with a coordinated PostgreSQL backup and the persistent encryption key. Preserve ownership and mode bits, restore into an empty private directory, and mount the same restored data into API and Worker. Validate authenticated downloads, template copies, exports and retention on a restored staging instance before allowing writes. See [STORAGE.md](STORAGE.md) and the [Helm operational notes](../infrastructure/helm/orvyn/README.md). Switching the driver is not a data migration.
