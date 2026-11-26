# Deployment hardening report

This report covers the development source **0.3.0-dev.0**. Chart, application,
workspace packages and default application-image tags remain aligned. Published
0.2.0 images do not contain these changes. Source commits do not publish a new
chart, image release or Cloud environment.

## Causes and resulting behavior

| Observed problem                                                            | Cause                                                                                                             | Implemented behavior                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL/Valkey cannot create data directories; API storage startup fails | NFS provisioned root:root/0755 while services run non-root; fsGroup did not grant access on the reported backend. | A shared permission helper probes real writes, rename and fsync as the service UID, optionally repairs a dedicated mount, and verifies as that UID. Root-squash denial produces owner/mode/UID/GID diagnostics and requires authorized server-side provisioning. |
| Authentik discovery fails despite valid reachable metadata                  | Removing the issuer's trailing slash changed its identity.                                                        | Exact issuer preservation and verification, with narrowly constrained legacy slash repair that preserves provider IDs and external identities.                                                                                                                   |
| SSO is absent after an earlier storage failure                              | Configuration depended on an API-ready post-install hook.                                                         | An independent, single-replica configuration Deployment migrates/reconciles through advisory locks, retries and recovers independently of attachment/SMTP/Valkey readiness.                                                                                      |
| Browser sees raw callback JSON                                              | Expected authentication failures used the API exception path; the web proxy also discarded Accept.                | Browser/JSON negotiation survives the proxy. Browsers return to a fixed login error code; JSON clients retain their HTTP statuses.                                                                                                                               |
| Invitations disappear during SSO                                            | Only local sign-in was offered; invitation state lived only in memory.                                            | Provider buttons, encrypted ten-minute continuation, browser/flow/account binding, reload support and explicit verified-email acceptance.                                                                                                                        |
| Legitimate collaboration WebSockets get 403                                 | Web did not receive ORVYN_ORIGIN and compared against a localhost fallback.                                       | All components use the explicit production origin; the same-origin HTTPS/WSS proxy retains origin/session checks.                                                                                                                                                |
| Recovery and dependency failures are opaque or can expose raw errors        | Generic messages, module-scope client construction, library console output and URL-bearing proxy errors.          | Safe structured stages/categories, validation before client imports, bounded database connects and sanitized library/proxy failure paths.                                                                                                                        |
| Internal S3 bootstrap stops recovering                                      | A finite failed Job no longer retries after the underlying mount/service is corrected.                            | Managed bootstrap waits/retries by default and verifies its own probe object; optional Kubernetes deadline remains available.                                                                                                                                    |

CI's Kubernetes/integration log pipelines now explicitly use Bash and pipefail,
so tee cannot mask a failed validator. A regression executes the actual step
scripts with both successful and deliberately failing validators and verifies
that logs survive in either case.

## Persistent storage

`volumePermissions` applies to persistent PostgreSQL, Valkey, local API and worker
attachments, SeaweedFS and backups. Ephemeral mounts do not get ownership repair.
Container UID/GID overrides take precedence over Pod settings and documented image
defaults. Ownership uses fsGroup when present, otherwise runtime GID. Shared local
API/worker storage requires a common UID and consistent volume group.

| Option                                                                         | Purpose/default                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `volumePermissions.strategy`                                                   | `auto`: real non-root probe → optional root repair → non-root verification.                                                          |
| `fsGroup` strategy                                                             | Non-root preparation/probe only; requires working CSI/kubelet ownership or server-provisioned permissions.                           |
| `initContainer` strategy                                                       | Explicit ownership preparation followed by non-root verification.                                                                    |
| `none` strategy                                                                | Operator prepares storage; no helper containers.                                                                                     |
| `volumePermissions.recursive`                                                  | `onRootMismatch`; `always` explicitly inspects imported/mixed descendants; `never` requires their ownership to be pre-provisioned.   |
| `volumePermissions.image`                                                      | Empty repository inherits the complete API image, digest and pull policy. Overrides must contain the matching compiled Orvyn helper. |
| `volumePermissions.resources`                                                  | Configurable requests/limits, default 10m/48Mi requests and 500m/128Mi limits.                                                       |
| `volumePermissions.securityContext` / `volumePermissions.probeSecurityContext` | Configurable limited root repair and forced actual non-root verification identities.                                                 |

Healthy auto probes skip ownership walks. Private mode preparation and root
ownership repair persist an incomplete marker before changing descendants;
interrupted operations resume even if a previous attempt already corrected the
boundary. Private directories/files use 0700/0600. Read-only critical service
directories receive required owner access. The walker pins directory descriptors,
does not follow symlinks/hardlinks/nested mounts, preserves bytes and leaves
`lost+found` alone. It does not delete/recreate PVCs or use chmod 777.

The API/worker local driver uses a shared private hashed namespace, exclusive
temporary files, file fsync, atomic rename and directory fsync. Concurrent readers
see complete generations. Active upload timestamps prevent another worker's
age-based cleanup from treating a stalled live upload as abandoned. Local mode
works without S3 configuration or a running S3 service.

For the reported Democratic CSI `org.democratic-csi.nfs` / TrueNAS
`freenas-api-nfs` / `nfs-rwx` case, a root init cannot bypass root squashing or
server ACLs. Provision the required **numeric** service owner/permissions on the
dataset/provisioner when the export denies chown. Denied repair never bypasses
verification; the failed verification retries after backend correction. The chart
does not alter export security or cluster policy. See
[NFS + Authentik values](../infrastructure/helm/orvyn/examples/nfs-authentik.yaml).

## OIDC, invitations and configuration

Issuers remain exact strings, including root/path trailing slashes. The legacy
repair only accepts the old issuer plus its single removed slash after authoritative
discovery verification. Linked accounts require explicit `repairLegacyIssuer`
approval. Existing provider UUIDs, subjects and user IDs remain stable; collisions
and real issuer/client identity changes require an explicit migration. Old provider
sessions/flows are invalidated safely. TLS, signature, issuer, PKCE, nonce and state
checks remain enabled.

Managed configuration preserves unchanged encrypted secrets and historical provider
IDs. `configuration.reconcileIntervalSeconds=30` and `retryIntervalSeconds=5`
are configurable in Rancher. Readiness follows successful desired configuration
and expires if progress stops. Recreate updates prevent old/new reconcilers from
continuously applying conflicting desired states. A credential-free pre-upgrade
compatibility Job lets Helm retire the old configuration hook; GitOps users should
prune retired legacy hook resources. API/storage readiness is independent.

Browser callback failures use fixed error identifiers and no-referrer responses.
Provisioning remains explicitly disabled by default: already-linked identities
work, new identities require enabled provisioning and verified email. Existing
accounts are never linked by matching email alone. Provider availability refreshes
without requiring a reload after configuration recovery.

Invitation continuations are encrypted in PostgreSQL, indexed by a random
HttpOnly SameSite=Lax cookie's hash, bound to the flow and then the completed
account. Production cookies are Secure. Same-origin JSON requests resume them;
tokens never enter the provider URL, return query or browser storage. Users must
explicitly accept with the exact invited verified email. Failed login, wrong
identity and unverified email do not consume invitations. Cancel, acceptance,
revocation and expiry clean up continuation state; the newest invitation login
replaces the previous browser context. After ten minutes reopen the original link.

## Diagnostics and security

`logging.level` exposes debug/info/warn/error. API, worker, web, collaboration,
configuration and permission/storage bootstrap emit safe structured diagnostics.
Filesystem records include configured mount, numeric owners, expected/effective
UID/GID, fsGroup, mode, operation, errno and an action. Object names, payloads,
connection strings, client secrets, passwords, encryption keys, codes and tokens
are excluded, including from debug/library errors and unavailable-API callbacks.
OIDC categories distinguish DNS/network/timeout/TLS, metadata, issuer mismatch,
client authentication and decryption. PostgreSQL connects time out after five
seconds; Valkey and S3 failures retain useful safe categories.

Regular containers remain non-root. Auto/initContainer strategies render a root
init requiring a scoped admission exception: drop ALL, add only CHOWN/FOWNER/
DAC_OVERRIDE, no privilege escalation, no writable rootfs and no service-account
token. It receives no database/application secrets. Choose fsGroup/none with
correctly provisioned storage for Restricted namespaces. Admission inspects the
root init even when its repair would skip. No cluster-wide policy changes occur.

`configuration.activeDeadlineSeconds=0` leaves the internal S3 Job recoverable;
positive deadlines and backoff limits remain configurable. Helm/Rancher client
timeouts still apply, and atomic install cleanup can remove a failed release.
The bootstrap only creates its own internal bucket and deletes its own probe
objects; external buckets remain operator-managed.

Encryption keys accept 64 hexadecimal characters in either case and must remain
stable. SMTP credentials require individual URL encoding; production requires an
explicit sender. See [environment configuration](ENVIRONMENT.md) for examples.

## Changed implementation areas

- [Permission helper](../apps/api/src/volume-permissions.ts), shared Helm helper,
  app/infrastructure/backup templates, values/schema/questions and NFS example.
- [Filesystem storage](../apps/api/src/files/local.ts), health diagnostics and
  [internal bootstrap](../apps/api/src/commands/storage-init.ts).
- [OIDC configuration](../apps/api/src/auth/deployment-oidc.ts), exact discovery,
  issuer repair, [callback/controller](../apps/api/src/oidc.module.ts), invitation
  continuation and non-destructive migrations 46–48.
- [Configuration reconciler](../apps/api/src/commands/configure.ts), readiness,
  normal Deployment and legacy-hook retirement.
- API/worker/collaboration entrypoints, safe shared diagnostics, collaboration
  library logging, web runtime/API/WebSocket proxy configuration.
- Login/invitation/provider components, profile names and native whiteboard theme
  integration; ordinary page templates remain a roadmap item.
- Helm, Kind, image, storage, signed OIDC/Keycloak and Chromium regression tests;
  deployment, authentication, environment, storage and Rancher documentation.

## Upgrade and validation limits

Use matching chart/application/helper images. Preserve existing Secrets, encryption
key, PVC names, database and attachment backups. `existingClaim`, RWO/RWX and
StorageClass settings are supported; changing the driver/class/access mode does
not migrate data. Shared attachments across nodes require genuine RWX POSIX
rename/fsync semantics. Internal PostgreSQL/Valkey/SeaweedFS remain single-instance;
this is not verified HA.

Configuration-value rollback and interrupted-install recovery are exercised.
Application binary downgrade across a newer schema is separate: older binaries
can reject the newer migration version. Test a compatible binary or coordinated
restore on a new database; do not delete production migrations/PVCs to force a
downgrade. Coordinate database, attachment and key recovery.

Real TrueNAS/Democratic CSI, root-squashed NFS, Longhorn and k3s clusters were not
available in this Cloud environment. Named-volume/UID/capability fixtures simulate
denied ownership changes; they are **not real NFS compatibility tests**. Multi-node
NFS durability, vendor ACL policies, HA and performance need deployment-specific
validation. Local Kind is blocked by the Cloud host's rootless cgroup delegation;
the normal Ubuntu GitHub runner performs real Kind installation/upgrade tests.
HTTPS/WSS checks use a TLS edge fixture with its test CA trusted explicitly;
public hosting, a production ingress controller and certificate issuance were not
validated against an external deployment here.

## Verification results

- Complete local CI-equivalent application run: **280 passed, zero failed**
  (`GITHUB_ACTIONS=true node --env-file=.env scripts/test.mjs`).
- Four freshly built non-root images pass local HTTPS, secure sessions, private
  files, durable bidirectional WSS for different users, invalid-origin rejection
  and worker mail; **36 built assets** checked. An intentional S3 denial verifies
  nonzero status, sanitized annotations and retained diagnostics.
- Helm lint/schema/render/Kubeconform: **557 valid resources**, 27 modes,
  30 negative cases and 346 Rancher questions; real rendered Valkey probe passes.
- Web typecheck, version consistency and deterministic Helm packaging pass for
  `orvyn-0.3.0-dev.0.tgz`.
- Signed OIDC, invitation/Chromium, profile, migration, configuration-recovery and
  permission regressions pass their focused runs. The startup/logging/proxy/
  storage-recovery checks pass with canary secrets and real HTTP/S3 protocol requests.
- A full application-suite run exposed an obsolete plain-text collaboration
  log assertion. Its replacement verifies the structured event/code and passes
  together with the real coordination-loss/disconnection behavior.
- Release tooling: **23 tests pass**, including failed-validator propagation,
  retained log output and real Node failure annotations. Actionlint validates the
  updated CI workflow. Image and per-test failure reports redact credentials and
  generated sessions; container diagnostics retain both stdout and stderr.
- [GitHub Checks run #31](https://github.com/Lucas-Gruber/orvyn/actions/runs/45761331968),
  source `07b7daadf4444dd7c931d77e62fbe982ecb5b5fe`: all validation steps pass,
  including four freshly built production images, HTTPS/WSS collaboration between
  different users, invalid-origin rejection, real Kind install/upgrade/recovery
  and the complete integration suite. The run retains test output and UI
  screenshots. This report's later documentation-only commit does not change the
  verified application source.
