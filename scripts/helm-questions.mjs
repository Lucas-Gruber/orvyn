import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
const dir = new URL("../infrastructure/helm/orvyn/", import.meta.url);
const values = YAML.parse(await readFile(new URL("values.yaml", dir), "utf8"));
const questions = [];
const readable = (s) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\./g, " / ")
    .replace(/^./, (c) => c.toUpperCase());
const enums = {
  "storage.driver": ["local", "s3"],
  "ingress.tls.issuerKind": ["Issuer", "ClusterIssuer"],
  "sso.oidc.clientAuthMethod": [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ],
};
const info = {
  "backup.enabled": [
    "Schedule PostgreSQL backups",
    "Creates verified custom-format database snapshots on a dedicated retained PVC. Attachments, encryption keys and offsite copies require separate coordinated protection.",
  ],
  "backup.schedule": [
    "Database backup schedule",
    "Five numeric cron fields; default 17 2 * * * runs daily at 02:17 in the selected time zone.",
  ],
  "backup.timeZone": [
    "Backup time zone",
    "IANA time zone, e.g. Etc/UTC or Europe/Berlin. Requires Kubernetes 1.27 or later.",
  ],
  "backup.retentionCount": [
    "Completed snapshots to retain",
    "Keep 1–365 completed database snapshots. Old snapshots are removed only after a new archive passes verification.",
  ],
  "backup.image.digest": [
    "PostgreSQL client image digest",
    "Use pg_dump/pg_restore compatible with the database server. PostgreSQL 17 is pinned by default; override both tag and digest for a newer external server.",
  ],
  "global.origin": [
    "Public application URL",
    "One public HTTPS origin without path or trailing slash. Controls secure cookies, ingress and OIDC callbacks. TLS may terminate at the ingress or an upstream load balancer.",
  ],
  "global.generateSecrets": [
    "Generate missing secrets",
    "Helm CLI can generate and reuse retained secrets with lookup. Disable for deterministic GitOps and supply all credentials or references.",
  ],
  "global.encryptionKey": [
    "Persistent encryption key",
    "64 hexadecimal characters. Keep a recoverable backup; never replace this key on an existing database.",
  ],
  "global.existingEncryptionSecret": [
    "Existing encryption Secret",
    "Secret in the release namespace. Takes precedence over inline configuration.",
  ],
  "global.secretRevision": [
    "External Secret revision",
    "Change after rotating a referenced Secret to roll application pods. A Helm upgrade reruns OIDC configuration.",
  ],
  "storage.local.persistence.accessMode": [
    "Attachment volume access mode",
    "ReadWriteOnce: one API and one worker colocated on one node. ReadWriteMany: shared storage for replicas across nodes.",
  ],
  "storage.local.persistence.enabled": [
    "Persist local attachments",
    "Disabling persistence uses one API pod with a worker sidecar. All files disappear when this pod is replaced.",
  ],
  "sso.oidc.enabled": [
    "Enable OpenID Connect single sign-on",
    "Deployment-managed provider. Register <public URL>/api/v1/oidc/deployment/callback at the identity provider.",
  ],
  "sso.oidc.issuer": [
    "OIDC issuer URL",
    "HTTPS issuer discovery URL, e.g. https://login.example.org/realms/company.",
  ],
  "sso.oidc.clientAuthMethod": [
    "OIDC client authentication",
    "Basic or POST for a confidential client; none only for a public client with PKCE and no secret.",
  ],
  "sso.oidc.autoProvision": [
    "Provision verified identities",
    "Creates accounts only when the provider verifies their email. Existing local accounts are not linked by matching email.",
  ],
  "sso.oidc.adminSubject": [
    "Administrator subject (optional)",
    "Exact immutable IdP subject, not an email address. Grants administration only to this managed identity; removing it revokes that grant.",
  ],
  "sso.oidc.ca.existingSecret": [
    "Private IdP CA Secret (optional)",
    "PEM CA certificate for API discovery, token and JWKS requests. Does not disable TLS verification.",
  ],
  "smtp.url": [
    "SMTP connection URL",
    "Required unless an existing Secret is selected. Use smtp:// or smtps://; encode credentials in URLs.",
  ],
  "smtp.from": [
    "Mail sender",
    "Verified sender accepted by the SMTP provider. The worker requires SMTP configuration.",
  ],
  "ingress.tls.issuer": [
    "cert-manager issuer (optional)",
    "Issuer resource must already exist. Leave blank to use an existing TLS Secret.",
  ],
};
function visibility(path) {
  const conditions = [];
  if (
    /\.(image|podSecurityContext|securityContext|nodeSelector|affinity|tolerations|podLabels|podAnnotations|startupProbe|readinessProbe|livenessProbe)(\.|$)/.test(
      path,
    ) ||
    /imagePullSecrets|nameOverride|fullnameOverride|serviceAccount|configuration/.test(
      path,
    )
  )
    conditions.push("global.showAdvanced=true");
  if (path.startsWith("externalPostgresql."))
    conditions.push("postgresql.enabled=false");
  else if (path.startsWith("postgresql.") && path !== "postgresql.enabled")
    conditions.push("postgresql.enabled=true");
  if (path.startsWith("externalValkey."))
    conditions.push("valkey.enabled=false");
  else if (path.startsWith("valkey.") && path !== "valkey.enabled")
    conditions.push("valkey.enabled=true");
  if (path.startsWith("storage.local."))
    conditions.push("storage.driver=local");
  if (path.startsWith("storage.s3.")) conditions.push("storage.driver=s3");
  if (
    path.startsWith("storage.s3.internal.") &&
    path !== "storage.s3.internal.enabled"
  )
    conditions.push("storage.s3.internal.enabled=true");
  if (path.startsWith("storage.s3.external."))
    conditions.push("storage.s3.internal.enabled=false");
  if (path.startsWith("sso.oidc.") && path !== "sso.oidc.enabled")
    conditions.push("sso.oidc.enabled=true");
  if (path.startsWith("backup.") && path !== "backup.enabled")
    conditions.push("backup.enabled=true");
  if (path.startsWith("ingress.") && path !== "ingress.enabled")
    conditions.push("ingress.enabled=true");
  if (path.startsWith("ingress.tls.") && path !== "ingress.tls.enabled")
    conditions.push("ingress.tls.enabled=true");
  return conditions.join("&&");
}
function walk(value, path = []) {
  const variable = path.join("."),
    name = path.at(-1);
  const raw = [
    "affinity",
    "tolerations",
    "startupProbe",
    "readinessProbe",
    "livenessProbe",
  ].includes(name);
  const map = [
    "nodeSelector",
    "podLabels",
    "podAnnotations",
    "annotations",
  ].includes(name);
  const array = name === "imagePullSecrets" || name === "drop";
  if (value && typeof value === "object" && !raw && !map && !array) {
    for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    return;
  }
  let group =
    path[0] === "global"
      ? "General"
      : path[0] === "postgresql" || path[0] === "externalPostgresql"
        ? "PostgreSQL"
        : path[0] === "valkey" || path[0] === "externalValkey"
          ? "Valkey"
          : path[0] === "storage"
            ? "Storage"
            : path[0] === "smtp"
              ? "SMTP"
              : path[0] === "sso"
                ? "SSO (OIDC)"
                : path[0] === "backup"
                  ? "Database backups"
                  : path[0] === "ingress"
                    ? "Networking"
                    : "Advanced";
  if (name === "replicaCount") group = "Scaling";
  if (path.includes("resources")) group = "Resources";
  let type =
    typeof value === "boolean"
      ? "boolean"
      : typeof value === "number"
        ? "int"
        : "string";
  if (raw) type = "yaml";
  if (map) type = "map[string]";
  if (array) type = name === "imagePullSecrets" ? "yaml" : "array[string]";
  if (
    [
      "password",
      "encryptionKey",
      "clientSecret",
      "secretAccessKey",
      "accessKeyId",
    ].includes(name) ||
    variable.endsWith(".url")
  )
    type = "password";
  if (["existingSecret", "existingEncryptionSecret"].includes(name))
    type = "secret";
  if (name === "storageClass") type = "storageclass";
  if (name === "existingClaim") type = "pvc";
  let options = enums[variable];
  if (name === "accessMode") options = ["ReadWriteOnce", "ReadWriteMany"];
  if (name === "pullPolicy") options = ["IfNotPresent", "Always", "Never"];
  if (name === "fsGroupChangePolicy") options = ["OnRootMismatch", "Always"];
  if (variable.endsWith(".service.type"))
    options =
      path[0] === "web"
        ? ["ClusterIP", "NodePort", "LoadBalancer"]
        : ["ClusterIP"];
  if (variable.endsWith(".seccompProfile.type"))
    options = ["RuntimeDefault", "Localhost"];
  if (options) type = "enum";
  const [label, description] = info[variable] || [
    readable(variable),
    name === "digest"
      ? "Pinned digest takes precedence over tag. Clear the digest when intentionally selecting another image tag."
      : raw
        ? "Optional native Kubernetes settings. Standard installation, secrets, storage, SSO, scaling and resource fields have individual controls."
        : name === "existingSecret"
          ? "Existing Secret in the release namespace; use the key field below for a custom key."
          : "",
  ];
  const question = {
    variable,
    label,
    type,
    default: value,
    group,
    ...(description ? { description } : {}),
    ...(options ? { options } : {}),
    ...(visibility(variable) ? { show_if: visibility(variable) } : {}),
  };
  questions.push(question);
}
walk(values);
const text =
  "# Field types verified against rancher/dashboard df071f35b5da8c21e35b134fa72a03159058c01c (Questions components).\n" +
  YAML.stringify({ questions });
if (process.argv.includes("--check")) {
  if ((await readFile(new URL("questions.yaml", dir), "utf8")) !== text)
    throw Error("Run node scripts/helm-questions.mjs");
} else await writeFile(new URL("questions.yaml", dir), text);
console.log(`${questions.length} Rancher questions match chart value defaults`);
