# Orvyn — Your knowledge. Organized.

![Orvyn](https://raw.githubusercontent.com/Lucas-Gruber/orvyn/main/infrastructure/helm/orvyn/icon.png)

Collaborative documents, structured databases, whiteboards and private attachments, deployed as Web, API, Worker and Collaboration. Only the web endpoint is public.

Choose a public HTTPS URL and SMTP connection before installation. The form offers internal PostgreSQL, authenticated Valkey and private SeaweedFS, or external services. Native local attachments support a shared PVC; select ReadWriteMany when using replicas across nodes. Default internal infrastructure is single-instance, not verified HA.

**SSO (OIDC)** has its own section: issuer, client ID, client authentication, client-secret reference, provisioning and an optional exact administrator subject. Register `<public URL>/api/v1/oidc/deployment/callback` at your IdP. Deployment-managed providers remain read-only in the app; local account recovery remains supported.

Copy the **exact issuer** from discovery metadata, including Authentik's trailing
slash. `sso.oidc.repairLegacyIssuer` explicitly approves a verified correction of
the old slash-removal bug when linked accounts exist. Provider/user IDs remain
stable; old provider sessions are revoked. See the chart's upgrade instructions.

The development chart's **Authentication** section can disable local self-registration or limit new local accounts to exact email domains. Existing sign-in/recovery and provider-controlled OIDC provisioning remain independent. Establish administrator access before closing signup. These controls require matching development-source images; published 0.2.0 does not support them.

Use existing namespace Secrets for GitOps and disable automatic generation. Keep the persistent encryption key and back up PostgreSQL and attachments together. Only select ephemeral storage for disposable tests. Expand Advanced for expert Kubernetes options.

The development chart's **Database backups** section can schedule verified PostgreSQL snapshots on a separate retained PVC, with count-based retention and isolated new-database restore tooling. These database-only snapshots need separate coordinated attachment/key backups and encrypted offsite copies; the published 0.2.0 chart does not include them.

See the bundled [chart README](README.md), [values](values.yaml) and [examples](examples/) for installation, OCI signature verification, storage migration, backup/restore, PVC expansion, compatible rollback and operational limits. Chart/app versions follow the server release; desktop icon assets do not imply a shipped desktop client.

The development chart runs OIDC configuration as an independent, single-replica
Deployment with automatic retries and readiness after successful application.
API/storage startup failures no longer require a second Helm upgrade to apply
SSO settings. Reconciliation/retry intervals are available under Configuration;
matching development images are required.

Space invitations also offer enabled SSO providers. Users return to an explicit
confirmation after login; a short-lived encrypted browser continuation preserves
the invitation. Accepting still requires the exact verified invited email.
Expected sign-in failures are explained in the login screen. If provisioning is
disabled, only already-linked SSO identities can sign in; enabling local signup
does not change that separate provider setting.

The **Volume permissions** section supports auto, fsGroup, explicit initContainer
or operator-managed preparation for every persistent data mount. Auto probes as
the service UID and repairs only when necessary; it requires admission of a
limited root init. Use fsGroup in Restricted namespaces with correctly provisioned
storage. Root-squashed NFS may require server-side numeric ownership/ACLs; failed
repair is diagnosed and never bypasses the final non-root write check. Existing
claims and data are preserved. The chart README documents advanced controls,
the TrueNAS/Democratic CSI case and the limits of available backend testing.
