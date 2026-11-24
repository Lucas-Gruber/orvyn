# Orvyn — Your knowledge. Organized.

![Orvyn](https://raw.githubusercontent.com/Lucas-Gruber/orvyn/main/infrastructure/helm/orvyn/icon.png)

Collaborative documents, structured databases, whiteboards and private attachments, deployed as Web, API, Worker and Collaboration. Only the web endpoint is public.

Choose a public HTTPS URL and SMTP connection before installation. The form offers internal PostgreSQL, authenticated Valkey and private SeaweedFS, or external services. Native local attachments support a shared PVC; select ReadWriteMany when using replicas across nodes. Default internal infrastructure is single-instance, not verified HA.

**SSO (OIDC)** has its own section: issuer, client ID, client authentication, client-secret reference, provisioning and an optional exact administrator subject. Register `<public URL>/api/v1/oidc/deployment/callback` at your IdP. Deployment-managed providers remain read-only in the app; local account recovery remains supported.

Use existing namespace Secrets for GitOps and disable automatic generation. Keep the persistent encryption key and back up PostgreSQL and attachments together. Only select ephemeral storage for disposable tests. Expand Advanced for expert Kubernetes options.

See the bundled [chart README](README.md), [values](values.yaml) and [examples](examples/) for installation, OCI signature verification, storage migration, backup/restore, PVC expansion, compatible rollback and operational limits. Chart/app versions follow the server release; desktop icon assets do not imply a shipped desktop client.
