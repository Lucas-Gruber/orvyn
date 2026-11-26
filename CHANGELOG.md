# Changelog

## 0.3.3

- Release the resizable sidebar and Mermaid conversion from 0.3.2 with corrected
  integration-test isolation. Test files receive independent throttle budgets;
  real per-account and 500-attempt peer limits remain enforced within each file.
- Version 0.3.2 failed its release checks after exhausting the shared test
  registration budget. Its tag is retained; no public 0.3.2 images/chart were
  published. Use the matching **0.3.3** application images and chart after release.

## 0.3.2 (not published)

- Resize the sidebar by dragging its right edge or using the keyboard. Widths
  persist per account/device, reset with Enter or double-click, and respect
  smaller desktop windows. Cancelled drags preserve the saved width; mobile
  keeps its drawer layout.
- Render recognizable Mermaid in existing plain-text code blocks using **Render
  diagram**. The source stays intact and conversion supports undo/redo, reload,
  collaboration and public snapshots. Explicit programming languages stay as
  code. This completes [issue #1](https://github.com/Lucas-Gruber/orvyn/issues/1).
- Upgrade the chart and all four application images together to **0.3.2** after
  publication. No new database migration is introduced.

## 0.3.1

- Fix local attachment reads racing with atomic replacement/deletion. Already-open
  complete generations remain readable while extra hard links and symlinks stay
  rejected; deterministic race and independent-process tests cover the behavior.
- Import larger Markdown roadmaps: up to 512 KB of UTF-8 source, with coordinated
  editor, HTTP and collaboration budgets instead of rejecting modest files after
  their formatting expands into structured blocks. Limit errors identify size,
  element count or nesting; failed reviews never create partial pages.
- Keep the saved document readable during initial connection problems, show a
  reconnect action, and preserve real pending edits across reconnect. Initial
  synchronization alone no longer produces a false unsaved-changes warning.

### Upgrade from 0.3.0

- Upgrade the chart and all four application images together to **0.3.1** after
  the tag-triggered release has completed. Remove explicit old image tags/digests
  if they would override the chart's application version.
- No new database migration is introduced. Keep existing Secrets, encryption keys
  and PVCs. Documents using the larger budgets can exceed 0.3.0's validation
  limits, so older binaries may refuse to open them after an application rollback.

## 0.3.0

### Editor and workspace

- Mermaid diagram blocks through `/mermaid` and `/diagram`, with editable source,
  live previews, theme colors, collaboration and published readers. Rendering is
  self-hosted in an isolated sandbox. Fenced Markdown preserves diagram code.
- Paste Markdown directly into native headings, lists, tasks, tables, quotes and
  code blocks. Undo, collaboration and fresh heading links are retained;
  Ctrl/Cmd+Shift+V keeps literal text and rich HTML keeps its formatting.
- Every sidebar plus opens a choice of page, whiteboard, database, folder or
  Markdown import. Nested creation and database templates retain their destination.
- Editable display names replace email addresses as the primary workspace
  identity. OIDC name/username claims populate profiles without overwriting a
  user-selected name.
- Whiteboard controls and embedded previews follow Orvyn themes and typography.

### Authentication and deployment

- Preserve exact OIDC issuers, including Authentik trailing slashes, with verified
  legacy repair that retains provider IDs and linked identities.
- SSO providers on space invitations, encrypted browser-bound continuation,
  explicit verified-email acceptance and friendly browser callback errors.
- Independent deployment configuration reconciliation recovers from database or
  storage startup failures without requiring another Helm upgrade.
- Shared volume permission strategies for PostgreSQL, Valkey, local attachments,
  SeaweedFS and backups, including resumable preparation and root-squash diagnostics.
- Safe structured startup/dependency logs, recoverable internal S3 bootstrap and
  consistent HTTPS origins across Web/API/Collaboration.
- Rancher controls for local signup and allowed email domains, separately from
  OIDC provisioning, plus scheduled PostgreSQL snapshots and isolated restore jobs.
- CI failures propagate through log pipelines and retain sanitized test/container
  diagnostics. The public repository and Helm guide share product imagery.

### Upgrade from 0.2.0

- Upgrade the chart and all four application images together to **0.3.0**. Empty
  application/helper image tags inherit the chart's exact application version;
  remove old explicit tag/digest overrides when changing versions. Only deploy
  after the [release workflow](https://github.com/Lucas-Gruber/orvyn/actions/workflows/release.yml)
  has completed publication.
- Preserve encryption keys, existing Secrets/PVCs and coordinated database and
  attachment backups. Migrations **46–48** add display names, issuer repair metadata
  and encrypted invitation continuation without recreating identities or data.
  Older binaries can reject the newer schema; configuration rollback does not
  establish binary/schema downgrade compatibility.
- Set the complete HTTPS `global.origin`, explicit SMTP sender and correctly
  URL-encoded SMTP credentials. OIDC issuers must match discovery exactly. Existing
  linked identities require explicit approval for the constrained legacy issuer
  repair; do not replace provider rows or disable issuer/TLS validation.
- The default `volumePermissions.strategy=auto` renders a narrowly privileged root
  repair init, followed by real non-root verification. Restricted namespaces can
  use `fsGroup`/`none` with properly provisioned storage. Root-squashed NFS may
  require server-side numeric ownership; the chart does not change export policy.
- GitOps users should prune the retired configuration hook; configuration now runs
  as an independent Deployment. Helm upgrades include legacy-hook retirement.
- Scheduled backups cover PostgreSQL only. Attachment/key coordination and offsite
  recovery remain deployment responsibilities. TrueNAS/Democratic CSI, Longhorn
  and multi-node NFS were not validated on real vendor clusters here.

See [deployment validation and limits](docs/DEPLOYMENT-HARDENING.md),
[authentication](docs/AUTHENTICATION.md), [backups](docs/BACKUP.md) and
[Mermaid usage](docs/MERMAID.md) for details. Desktop installers are not part of this
server release. Ordinary page templates remain on the roadmap.
