import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { checkVersions, root } from "./release.mjs";
import { helmImage, kubeconformImage } from "./helm-tools.mjs";
const chart = "infrastructure/helm/orvyn";
const temp = await mkdtemp(join(tmpdir(), "orvyn-chart-tests-"));
function docker(image, args, input) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--user",
      "0:0",
      "-v",
      `${root}:/repo:ro`,
      "-v",
      `${temp}:/checks:ro`,
      "-v",
      "/etc/ssl/certs/ca-certificates.crt:/certs/ca.crt:ro",
      "-e",
      "SSL_CERT_FILE=/certs/ca.crt",
      "-w",
      "/repo",
      image,
      ...args,
    ],
    { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
  );
  if (result.error) throw result.error;
  return result;
}
const docs = (text) =>
  YAML.parseAllDocuments(text, { uniqueKeys: true })
    .map((d) => {
      if (d.errors.length) throw d.errors[0];
      return d.toJSON();
    })
    .filter(Boolean);
try {
  const { version } = await checkVersions();
  for (const script of ["helm-schema.mjs", "helm-questions.mjs"]) {
    const r = spawnSync(process.execPath, [`scripts/${script}`, "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const values = YAML.parse(
    await readFile(join(root, chart, "values.yaml"), "utf8"),
  );
  const questions = YAML.parse(
    await readFile(join(root, chart, "questions.yaml"), "utf8"),
  ).questions;
  const types = new Set([
    "string",
    "boolean",
    "int",
    "enum",
    "password",
    "storageclass",
    "secret",
    "pvc",
    "yaml",
    "map[string]",
    "array[string]",
  ]);
  const seen = new Set();
  for (const q of questions) {
    assert.ok(!seen.has(q.variable), q.variable);
    seen.add(q.variable);
    assert.ok(types.has(q.type), q.type);
    const actual = q.variable.split(".").reduce((v, k) => v?.[k], values);
    assert.notEqual(actual, undefined, q.variable);
    assert.deepEqual(q.default, actual, q.variable);
    if (q.options) assert.ok(q.options.includes(actual), q.variable);
  }
  const cases = [
    ["all-in-one", {}, "all-in-one"],
    [
      "bounded-storage-bootstrap",
      {
        configuration: { activeDeadlineSeconds: 900, retryIntervalSeconds: 2 },
        logging: { level: "debug" },
      },
      "all-in-one",
    ],
    ["nfs-authentik", {}, "nfs-authentik"],
    [
      "permissions-fsgroup",
      { volumePermissions: { strategy: "fsGroup" }, backup: { enabled: true } },
      "all-in-one",
    ],
    [
      "permissions-none",
      { volumePermissions: { strategy: "none" }, backup: { enabled: true } },
      "local-storage",
    ],
    [
      "permissions-init-existing-claims",
      {
        volumePermissions: { strategy: "initContainer", recursive: "always" },
        postgresql: {
          securityContext: { runAsUser: 2222, runAsGroup: 2223 },
          podSecurityContext: { runAsUser: 888, fsGroup: 3333 },
          persistence: { existingClaim: "existing-pg" },
        },
        storage: {
          local: {
            path: "/var/lib/orvyn-files",
            persistence: {
              existingClaim: "existing-files",
              accessMode: "ReadWriteMany",
              storageClass: "nfs-rwx",
            },
          },
        },
        api: {
          securityContext: { runAsUser: 2000 },
          podSecurityContext: { fsGroup: 2345 },
        },
        worker: {
          securityContext: { runAsUser: 2000 },
          podSecurityContext: { fsGroup: 2345 },
        },
      },
      "local-storage",
    ],
    [
      "closed-registration",
      { auth: { registration: { enabled: false } } },
      "all-in-one",
    ],
    [
      "restricted-registration",
      { auth: { registration: { allowedEmailDomains: ["company.example"] } } },
      "all-in-one",
    ],
    ["database-backup", { backup: { enabled: true } }, "all-in-one"],
    ["local-database-backup", { backup: { enabled: true } }, "local-storage"],
    ["gitops-database-backup", { backup: { enabled: true } }, "gitops"],
    [
      "external-database-backup",
      {
        backup: {
          enabled: true,
          timeZone: "Europe/Berlin",
          persistence: { existingClaim: "private-database-backups" },
          ca: { existingSecret: "postgres-ca" },
        },
      },
      "external-postgresql",
    ],
    ["local-storage", {}, "local-storage"],
    [
      "local-rwx",
      {
        storage: {
          driver: "local",
          local: { persistence: { accessMode: "ReadWriteMany" } },
        },
        api: { replicaCount: 2 },
        worker: { replicaCount: 2 },
      },
      "all-in-one",
    ],
    ["external-postgresql", {}, "external-postgresql"],
    ["external-valkey", {}, "external-valkey"],
    ["external-s3", {}, "external-s3"],
    ["external-services", {}, "external-services"],
    ["gitops", {}, "gitops"],
    ["oidc", {}, "oidc"],
    [
      "oidc-legacy-repair-private-ca",
      {
        sso: {
          oidc: {
            repairLegacyIssuer: true,
            ca: { existingSecret: "identity-ca", secretKey: "trust.pem" },
          },
        },
      },
      "oidc",
    ],
    [
      "public-oidc",
      {
        sso: {
          oidc: {
            enabled: true,
            name: "Public SSO",
            issuer: "https://login.example.org",
            clientId: "public",
            clientAuthMethod: "none",
          },
        },
      },
      "all-in-one",
    ],
    ["no-ingress", { ingress: { enabled: false } }, "all-in-one"],
    [
      "external-tls-termination",
      {
        ingress: { tls: { enabled: false } },
      },
      "all-in-one",
    ],
    [
      "ephemeral-s3",
      {
        postgresql: { persistence: { enabled: false } },
        valkey: { persistence: { enabled: false } },
        storage: { s3: { internal: { persistence: { enabled: false } } } },
      },
      "all-in-one",
    ],
    [
      "ephemeral-local",
      {
        storage: {
          driver: "local",
          local: { persistence: { enabled: false } },
        },
      },
      "all-in-one",
    ],
    [
      "custom-secrets",
      {
        global: {
          generateSecrets: false,
          existingEncryptionSecret: "crypto",
          encryptionSecretKey: "key",
        },
        postgresql: { auth: { existingSecret: "pg", secretKey: "password" } },
        valkey: { auth: { existingSecret: "cache", secretKey: "password" } },
        storage: {
          s3: {
            existingSecret: "objects",
            accessKeySecretKey: "access",
            secretAccessKeySecretKey: "secret",
          },
        },
      },
      "all-in-one",
    ],
  ];
  const manifestFiles = [];
  await cp(join(root, chart), join(temp, "metadata-chart"), {
    recursive: true,
  });
  const metadataPath = join(temp, "metadata-chart", "Chart.yaml");
  const metadata = YAML.parse(await readFile(metadataPath, "utf8"));
  metadata.version = metadata.appVersion = "1.2.3+build." + "x".repeat(70);
  await writeFile(metadataPath, YAML.stringify(metadata));
  await writeFile(
    join(temp, "metadata-overlay.yaml"),
    YAML.stringify({
      global: {
        cattle: {
          clusterId: "c-test",
          clusterName: "chart-tests",
          systemDefaultRegistry: "",
        },
      },
      fullnameOverride: "orvyn-" + "x".repeat(39),
      backup: { enabled: true },
      smtp: { existingSecret: "mail" },
      ingress: {
        tls: { issuer: "company" },
        annotations: {
          "cert-manager.io/cluster-issuer": "old",
          "cert-manager.io/issuer": "old",
        },
      },
    }),
  );
  const metadataRender = docker(helmImage, [
    "template",
    "metadata",
    "/checks/metadata-chart",
    "-f",
    "/checks/metadata-overlay.yaml",
  ]);
  assert.equal(metadataRender.status, 0, metadataRender.stderr);
  for (const resource of docs(metadataRender.stdout).filter(
    (r) => r.kind === "Deployment",
  ))
    for (const container of resource.spec.template.spec.containers)
      assert.ok(
        container.image.endsWith(":" + metadata.appVersion.replace("+", "_")),
        "Docker image tags must escape SemVer build metadata",
      );
  for (const resource of docs(metadataRender.stdout)) {
    assert.ok(
      resource.metadata.name.length <= 63,
      "Resource names must fit Kubernetes Job/service limits",
    );
    if (resource.kind === "CronJob")
      assert.ok(
        resource.metadata.name.length <= 52,
        "CronJob names must leave room for generated Job names",
      );
    for (const value of Object.values(resource.metadata.labels || {}))
      assert.ok(
        value.length <= 63 &&
          /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value),
        "Long SemVer metadata must produce valid Kubernetes labels",
      );
  }
  const metadataIngress = docs(metadataRender.stdout).find(
    (r) => r.kind === "Ingress",
  );
  assert.equal(
    metadataIngress.metadata.annotations["cert-manager.io/cluster-issuer"],
    "company",
  );
  assert.equal(
    metadataIngress.metadata.annotations["cert-manager.io/issuer"],
    undefined,
  );
  console.log(
    "PASS chart SemVer build metadata and cert-manager annotation precedence",
  );
  let internal;
  for (const [name, overlay, example] of cases) {
    await writeFile(join(temp, "overlay.yaml"), YAML.stringify(overlay), {
      mode: 0o600,
    });
    const args = [
      "-f",
      `${chart}/examples/${example}.yaml`,
      "-f",
      "/checks/overlay.yaml",
    ];
    const lint = docker(helmImage, ["lint", "--strict", chart, ...args]);
    assert.equal(lint.status, 0, `${name}: ${lint.stderr}\n${lint.stdout}`);
    const render = () =>
      docker(helmImage, ["template", "orvyn", chart, ...args]);
    const rendered = render();
    assert.equal(rendered.status, 0, `${name}: ${rendered.stderr}`);
    const resources = docs(rendered.stdout);
    assert.ok(resources.length > 0);
    const deployments = resources.filter((r) => r.kind === "Deployment");
    const storageBootstrap = resources.find(
      (r) => r.kind === "Job" && r.metadata.name.includes("-storage-init-"),
    );
    if (storageBootstrap) {
      assert.equal(
        storageBootstrap.spec.activeDeadlineSeconds,
        overlay.configuration?.activeDeadlineSeconds || undefined,
      );
      const container = storageBootstrap.spec.template.spec.containers[0];
      assert.ok(container.command.includes("--wait"));
      assert.equal(
        container.env.find(
          (e) => e.name === "ORVYN_CONFIGURATION_RETRY_SECONDS",
        ).value,
        String(overlay.configuration?.retryIntervalSeconds || 5),
      );
    }
    const config = resources.find(
      (r) =>
        r.kind === "Deployment" && r.metadata.name.endsWith("-configuration"),
    );
    assert.equal(config.metadata.annotations?.["helm.sh/hook"], undefined);
    assert.equal(config.spec.replicas, 1);
    assert.equal(config.spec.strategy.type, "Recreate");
    const configuration = config.spec.template.spec.containers[0];
    assert.ok(configuration.command.includes("--watch"));
    assert.ok(
      configuration.readinessProbe.exec.command.includes(
        "dist/commands/configure-health.js",
      ),
    );
    assert.ok(
      !configuration.env.some((e) => /^(SMTP_|S3_|VALKEY_)/.test(e.name)),
      "Configuration is independent of attachment, SMTP and Valkey availability",
    );
    if (name === "oidc-legacy-repair-private-ca") {
      const pod = config.spec.template.spec,
        container = pod.containers[0];
      assert.equal(
        container.env.find((e) => e.name === "ORVYN_OIDC_REPAIR_LEGACY_ISSUER")
          .value,
        "true",
      );
      assert.equal(
        container.env.find((e) => e.name === "NODE_EXTRA_CA_CERTS").value,
        "/etc/orvyn/oidc/ca.crt",
      );
      assert.equal(
        container.volumeMounts.find((m) => m.name === "oidc-ca").readOnly,
        true,
      );
      assert.equal(
        pod.volumes.find((v) => v.name === "oidc-ca").secret.items[0].key,
        "trust.pem",
      );
    }
    assert.ok(
      !resources.some(
        (r) => r.kind === "Service" && r.metadata.name.endsWith("-worker"),
      ),
    );
    for (const r of resources.filter((r) =>
      ["Deployment", "StatefulSet", "Job", "CronJob"].includes(r.kind),
    )) {
      const pod =
        r.kind === "CronJob"
          ? r.spec.jobTemplate.spec.template.spec
          : r.spec.template.spec;
      assert.equal(pod.automountServiceAccountToken, false);
      for (const c of [...pod.containers, ...(pod.initContainers || [])]) {
        assert.equal(c.securityContext.allowPrivilegeEscalation, false);
        assert.ok(
          c.image.includes("@sha256:") || c.image.endsWith(":" + version),
        );
      }
      const strategy = overlay.volumePermissions?.strategy ?? "auto";
      const helpers = (pod.initContainers || []).filter((c) =>
        c.name.startsWith("volume-"),
      );
      const persistentMounts =
        pod.volumes?.filter((v) => v.persistentVolumeClaim) || [];
      const phases =
        strategy === "none"
          ? []
          : strategy === "fsGroup"
            ? ["verify"]
            : strategy === "initContainer"
              ? ["repair", "verify"]
              : ["probe", "repair", "verify"];
      assert.equal(
        helpers.length,
        persistentMounts.length * phases.length,
        name + ": all persistent mounts use the permission strategy",
      );
      for (const volume of persistentMounts) {
        const checks = helpers.filter((c) =>
          c.name.startsWith("volume-" + volume.name + "-"),
        );
        assert.deepEqual(
          checks.map((c) => c.args[0]),
          phases,
        );
        const app = pod.containers[0];
        const fallback = /postgresql|valkey|backup/.test(app.name) ? 999 : 1000;
        const uid =
          app.securityContext.runAsUser ??
          pod.securityContext.runAsUser ??
          fallback;
        const gid =
          app.securityContext.runAsGroup ??
          pod.securityContext.runAsGroup ??
          fallback;
        for (const check of checks) {
          const arg = (key) => check.args[check.args.indexOf(key) + 1];
          assert.equal(arg("--uid"), String(uid));
          assert.equal(arg("--gid"), String(gid));
          assert.equal(
            check.volumeMounts[0].mountPath,
            app.volumeMounts.find((m) => m.name === volume.name).mountPath,
          );
          assert.deepEqual(
            check.env.map((e) => e.name),
            ["ORVYN_LOG_LEVEL"],
            "Permission helpers receive no credentials",
          );
          assert.equal(check.securityContext.readOnlyRootFilesystem, true);
          assert.deepEqual(check.securityContext.capabilities.drop, ["ALL"]);
          if (check.args[0] === "repair") {
            assert.equal(check.securityContext.runAsUser, 0);
            assert.deepEqual(check.securityContext.capabilities.add, [
              "CHOWN",
              "FOWNER",
              "DAC_OVERRIDE",
            ]);
          } else {
            assert.equal(check.securityContext.runAsUser, uid);
            assert.equal(check.securityContext.runAsGroup, gid);
            assert.equal(check.securityContext.runAsNonRoot, true);
            assert.deepEqual(check.securityContext.capabilities.add, []);
          }
          if (pod.securityContext.fsGroup)
            assert.equal(
              arg("--fs-group"),
              String(pod.securityContext.fsGroup),
            );
        }
      }
      if (helpers.length) {
        assert.ok(
          pod.volumes.find((v) => v.name === "volume-permissions-state")
            .emptyDir,
        );
        const otherInit = (pod.initContainers || []).filter(
          (c) => !helpers.includes(c),
        );
        for (const c of otherInit)
          assert.ok(
            pod.initContainers.indexOf(c) >
              pod.initContainers.indexOf(helpers.at(-1)),
            "Permission preparation precedes schema/S3 configuration init",
          );
      }
    }
    const api = deployments.find((d) => d.metadata.name.endsWith("-api")).spec
      .template.spec.containers[0];
    assert.equal(
      api.env.find((e) => e.name === "ORVYN_REGISTRATION_ENABLED").value,
      String(overlay.auth?.registration?.enabled ?? true),
    );
    assert.equal(
      api.env.find((e) => e.name === "ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS")
        .value,
      (overlay.auth?.registration?.allowedEmailDomains || []).join(","),
    );
    if (name === "closed-registration" || name === "restricted-registration") {
      for (const component of ["api", "web", "worker", "collaboration"]) {
        const checksum = deployments.find((d) =>
          d.metadata.name.endsWith("-" + component),
        ).spec.template.metadata.annotations["checksum/config"];
        const previous = internal.find(
          (d) =>
            d.kind === "Deployment" &&
            d.metadata.name.endsWith("-" + component),
        ).spec.template.metadata.annotations["checksum/config"];
        if (component === "api")
          assert.notEqual(
            checksum,
            previous,
            "Registration policy changes must roll API replicas",
          );
        else
          assert.equal(
            checksum,
            previous,
            "Registration changes do not roll unrelated services",
          );
      }
    }
    assert.ok(!api.env.some((e) => e.name === "ORVYN_OIDC_CLIENT_SECRET"));
    const web = deployments.find((d) => d.metadata.name.endsWith("-web")).spec
      .template.spec.containers[0];
    for (const deployment of deployments) {
      for (const container of deployment.spec.template.spec.containers) {
        assert.equal(
          container.env.find((e) => e.name === "ORVYN_ORIGIN")?.value,
          "https://orvyn.example.org",
        );
        assert.equal(
          container.env.find((e) => e.name === "ORVYN_LOG_LEVEL")?.value,
          overlay.logging?.level || "info",
        );
      }
    }
    assert.ok(!web.env.some((e) => e.valueFrom));
    const valkey = resources.find(
      (r) => r.kind === "StatefulSet" && r.metadata.name.endsWith("-valkey"),
    );
    if (valkey)
      assert.equal(valkey.spec.template.spec.securityContext.fsGroup, 999);
    if (name === "all-in-one") {
      internal = resources;
      const upgrade = docker(helmImage, [
        "template",
        "orvyn",
        chart,
        ...args,
        "--is-upgrade",
      ]);
      assert.equal(upgrade.status, 0, upgrade.stderr);
      const legacy = docs(upgrade.stdout).find(
        (r) => r.kind === "Job" && r.metadata.name.endsWith("-configuration"),
      );
      assert.equal(legacy.metadata.annotations["helm.sh/hook"], "pre-upgrade");
      assert.match(
        legacy.metadata.annotations["helm.sh/hook-delete-policy"],
        /before-hook-creation/,
      );
      const pod = legacy.spec.template.spec;
      assert.equal(pod.automountServiceAccountToken, false);
      assert.ok(!pod.containers[0].env?.length);
      assert.ok(!pod.volumes?.length);
      assert.deepEqual(pod.containers[0].command, [
        "node",
        "-e",
        "process.exit(0)",
      ]);
      await writeFile(join(temp, "legacy-upgrade.yaml"), upgrade.stdout, {
        mode: 0o600,
      });
      manifestFiles.push("/checks/legacy-upgrade.yaml");
      const bootstrap = resources.find(
        (r) => r.kind === "Job" && r.metadata.name.includes("-storage-init-"),
      );
      assert.ok(bootstrap);
      assert.equal(bootstrap.metadata.annotations?.["helm.sh/hook"], undefined);
      const second = docs(render().stdout);
      const checks = (a) =>
        a
          .filter((r) => r.kind === "Deployment" || r.kind === "StatefulSet")
          .map((r) => r.spec.template.metadata.annotations);
      assert.deepEqual(
        checks(resources),
        checks(second),
        "random secrets must not perturb rollout checksums",
      );
    }
    if (name === "gitops" || name === "gitops-database-backup") {
      assert.equal(
        resources.some((r) => r.kind === "Secret"),
        false,
      );
      assert.equal(
        rendered.stdout,
        render().stdout,
        "GitOps rendering is deterministic without lookup",
      );
    }
    if (name === "ephemeral-local") {
      assert.equal(deployments.length, 4);
      assert.deepEqual(
        deployments
          .find((r) => r.metadata.name.endsWith("-api"))
          .spec.template.spec.containers.map((c) => c.name),
        ["api", "worker"],
      );
    }
    if (name === "local-storage") {
      assert.equal(
        resources.some((r) => r.metadata.name.endsWith("-storage")),
        false,
      );
      for (const d of deployments.filter((d) =>
        /-(api|worker)$/.test(d.metadata.name),
      ))
        assert.ok(
          d.spec.template.spec.affinity.podAffinity
            .requiredDuringSchedulingIgnoredDuringExecution.length,
        );
    }
    const backup = resources.find((r) => r.kind === "CronJob");
    if (overlay.backup?.enabled) {
      assert.ok(backup);
      assert.equal(backup.spec.concurrencyPolicy, "Forbid");
      assert.equal(backup.spec.jobTemplate.spec.backoffLimit, 0);
      const pod = backup.spec.jobTemplate.spec.template.spec;
      assert.equal(pod.restartPolicy, "Never");
      assert.equal(pod.securityContext.fsGroup, 999);
      const job = pod.containers[0];
      assert.deepEqual(job.command, [
        "/bin/bash",
        "/scripts/backup-postgresql.sh",
      ]);
      assert.equal(job.securityContext.readOnlyRootFilesystem, true);
      assert.ok(
        !job.env.some((e) =>
          /ENCRYPTION|S3_|SMTP|OIDC|VALKEY|REDIS/.test(e.name),
        ),
        "Backup jobs receive database credentials only",
      );
      const scripts = resources.find(
        (r) =>
          r.kind === "ConfigMap" && r.metadata.name === backup.metadata.name,
      );
      for (const file of [
        "postgresql-common.sh",
        "prepare-backup-volume.sh",
        "backup-postgresql.sh",
        "restore-postgresql.sh",
      ])
        assert.equal(
          scripts.data[file],
          await readFile(join(root, chart, "files", file), "utf8"),
        );
      const claim = pod.volumes.find((v) => v.name === "backups")
        .persistentVolumeClaim.claimName;
      const initialize = resources.find(
        (r) => r.kind === "Job" && r.metadata.name.includes("-backup-volume-"),
      );
      assert.ok(
        initialize,
        "A regular volume initialization Job must bind delayed backup claims before Helm waits",
      );
      assert.equal(
        initialize.metadata.annotations?.["helm.sh/hook"],
        undefined,
      );
      const initializer = initialize.spec.template.spec;
      assert.deepEqual(initializer.containers[0].command, [
        "/bin/bash",
        "/scripts/prepare-backup-volume.sh",
      ]);
      assert.deepEqual(
        initializer.containers[0].env.map((e) => e.name),
        ["ORVYN_BACKUP_DIRECTORY"],
        "Volume initialization needs no database or application credentials",
      );
      assert.equal(
        initializer.volumes.find((v) => v.name === "backups")
          .persistentVolumeClaim.claimName,
        claim,
      );
      if (name === "external-database-backup") {
        assert.equal(claim, "private-database-backups");
        assert.ok(
          !resources.some(
            (r) =>
              r.kind === "PersistentVolumeClaim" && r.metadata.name === claim,
          ),
        );
        assert.ok(
          job.env.find((e) => e.name === "DATABASE_URL")?.valueFrom
            .secretKeyRef,
        );
        assert.equal(
          pod.volumes.find((v) => v.name === "database-ca").secret.secretName,
          "postgres-ca",
        );
      } else {
        assert.equal(
          resources.find(
            (r) =>
              r.kind === "PersistentVolumeClaim" && r.metadata.name === claim,
          ).metadata.annotations["helm.sh/resource-policy"],
          "keep",
        );
      }
    } else assert.equal(backup, undefined, "Backups are opt-in");

    await writeFile(join(temp, name + ".yaml"), rendered.stdout, {
      mode: 0o600,
    });
    manifestFiles.push("/checks/" + name + ".yaml");
    console.log(
      `PASS Helm lint, schema, render and architecture: ${name} (${resources.length} resources)`,
    );
  }
  const invalid = [
    [
      "unknown permission strategy",
      {
        smtp: { existingSecret: "mail" },
        volumePermissions: { strategy: "guess" },
      },
    ],
    [
      "unknown permission recursion",
      {
        smtp: { existingSecret: "mail" },
        volumePermissions: { recursive: "chmod777" },
      },
    ],
    [
      "excess permission capability",
      {
        smtp: { existingSecret: "mail" },
        volumePermissions: {
          securityContext: { capabilities: { add: ["SYS_ADMIN"] } },
        },
      },
    ],
    [
      "root regular API",
      {
        smtp: { existingSecret: "mail" },
        api: { securityContext: { runAsUser: 0 } },
      },
    ],
    [
      "mismatched shared attachment group",
      {
        smtp: { existingSecret: "mail" },
        storage: { driver: "local" },
        worker: { podSecurityContext: { fsGroup: 2000 } },
      },
    ],
    [
      "zero configuration interval",
      {
        smtp: { existingSecret: "mail" },
        configuration: { reconcileIntervalSeconds: 0 },
      },
    ],
    [
      "unbounded configuration retries",
      {
        smtp: { existingSecret: "mail" },
        configuration: { retryIntervalSeconds: 301 },
      },
    ],
    [
      "wildcard registration domain",
      {
        smtp: { existingSecret: "mail" },
        auth: { registration: { allowedEmailDomains: ["*.company.example"] } },
      },
    ],
    [
      "URL registration domain",
      {
        smtp: { existingSecret: "mail" },
        auth: {
          registration: { allowedEmailDomains: ["https://company.example"] },
        },
      },
    ],
    [
      "duplicate registration domains",
      {
        smtp: { existingSecret: "mail" },
        auth: {
          registration: {
            allowedEmailDomains: ["company.example", "company.example"],
          },
        },
      },
    ],
    [
      "too many registration domains",
      {
        smtp: { existingSecret: "mail" },
        auth: {
          registration: {
            allowedEmailDomains: Array.from(
              { length: 21 },
              (_, i) => `company${i}.example`,
            ),
          },
        },
      },
    ],
    [
      "ephemeral backup storage",
      {
        smtp: { existingSecret: "mail" },
        backup: { enabled: true, persistence: { enabled: false } },
      },
    ],
    [
      "zero backup retention",
      { smtp: { existingSecret: "mail" }, backup: { retentionCount: 0 } },
    ],
    [
      "unbounded backup retention",
      { smtp: { existingSecret: "mail" }, backup: { retentionCount: 366 } },
    ],
    [
      "invalid backup cron fields",
      {
        smtp: { existingSecret: "mail" },
        backup: { schedule: "every midnight" },
      },
    ],
    [
      "different local worker UID",
      {
        smtp: { existingSecret: "mail" },
        storage: { driver: "local" },
        worker: { podSecurityContext: { runAsUser: 2000 } },
      },
    ],
    [
      "S3 endpoint with embedded credentials",
      {
        smtp: { existingSecret: "mail" },
        storage: {
          s3: {
            internal: { enabled: false },
            existingSecret: "objects",
            external: { endpoint: "https://user:password@s3.example.org" },
          },
        },
      },
    ],
    ["missing SMTP", {}],
    [
      "bad encryption",
      { smtp: { existingSecret: "mail" }, global: { encryptionKey: "wrong" } },
    ],
    [
      "missing GitOps credentials",
      { smtp: { existingSecret: "mail" }, global: { generateSecrets: false } },
    ],
    [
      "missing external PG",
      { smtp: { existingSecret: "mail" }, postgresql: { enabled: false } },
    ],
    [
      "missing external Valkey",
      { smtp: { existingSecret: "mail" }, valkey: { enabled: false } },
    ],
    [
      "missing S3 endpoint",
      {
        smtp: { existingSecret: "mail" },
        storage: { s3: { internal: { enabled: false } } },
      },
    ],
    [
      "bad local scaling",
      {
        smtp: { existingSecret: "mail" },
        storage: { driver: "local" },
        api: { replicaCount: 2 },
      },
    ],
    [
      "invalid origin",
      {
        smtp: { existingSecret: "mail" },
        global: { origin: "https://orvyn.example.org/path" },
      },
    ],
    [
      "TLS scheme mismatch",
      {
        smtp: { existingSecret: "mail" },
        global: { origin: "http://orvyn.example.org" },
      },
    ],
    [
      "missing OIDC credentials",
      {
        smtp: { existingSecret: "mail" },
        sso: {
          oidc: {
            enabled: true,
            issuer: "https://login.example.org",
            clientId: "orvyn",
          },
        },
      },
    ],
    [
      "public OIDC with secret",
      {
        smtp: { existingSecret: "mail" },
        sso: {
          oidc: {
            enabled: true,
            issuer: "https://login.example.org",
            clientId: "orvyn",
            clientAuthMethod: "none",
            clientSecret: "test-only",
          },
        },
      },
    ],
    [
      "bad replica count",
      { smtp: { existingSecret: "mail" }, api: { replicaCount: 0 } },
    ],
    [
      "unknown legacy storage",
      {
        smtp: { existingSecret: "mail" },
        storage: { internal: { enabled: false } },
      },
    ],
  ];
  for (const [name, value] of invalid) {
    await writeFile(join(temp, "invalid.yaml"), YAML.stringify(value), {
      mode: 0o600,
    });
    assert.notEqual(
      docker(helmImage, [
        "template",
        "invalid",
        chart,
        "-f",
        "/checks/invalid.yaml",
      ]).status,
      0,
      name,
    );
    console.log("PASS rejected: " + name);
  }
  const validation = docker(kubeconformImage, [
    "-strict",
    "-summary",
    "-kubernetes-version",
    "1.33.0",
    ...manifestFiles,
  ]);
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  console.log(validation.stdout.trim());
  const valkeyPod = internal.find(
    (r) => r.kind === "StatefulSet" && r.metadata.name.endsWith("-valkey"),
  ).spec.template.spec;
  const valkey = valkeyPod.containers[0];
  const secret = internal.find(
    (r) =>
      r.kind === "Secret" &&
      r.metadata.name === valkey.env[0].valueFrom.secretKeyRef.name,
  );
  const password = secret.stringData[valkey.env[0].valueFrom.secretKeyRef.key];
  await writeFile(
    join(temp, "valkey.env"),
    "VALKEY_PASSWORD=" + password + "\n",
    { mode: 0o600 },
  );
  const name = "orvyn-chart-probe-" + randomBytes(6).toString("hex");
  try {
    const started = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-d",
        "--name",
        name,
        "--user",
        `${valkeyPod.securityContext.runAsUser}:${valkeyPod.securityContext.runAsGroup}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--env-file",
        join(temp, "valkey.env"),
        "--tmpfs",
        "/data:rw,uid=999,gid=999,mode=0700",
        "--tmpfs",
        "/tmp:rw,mode=1777",
        "--entrypoint",
        valkey.command[0],
        valkey.image,
        ...valkey.command.slice(1),
        ...valkey.args,
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(started.status, 0, started.stderr);
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = spawnSync(
        "docker",
        ["exec", name, ...valkey.startupProbe.exec.command],
        { encoding: "utf8", timeout: 5000 },
      );
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      ready,
      "The rendered Valkey startup probe must authenticate against the pinned official container",
    );
    const readiness = spawnSync(
      "docker",
      ["exec", name, ...valkey.readinessProbe.exec.command],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(readiness.status, 0, "Rendered Valkey readiness probe failed");
    const anonymous = spawnSync(
      "docker",
      ["exec", name, "valkey-cli", "ping"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.match(
      anonymous.stdout,
      /NOAUTH/,
      "Valkey must reject unauthenticated clients",
    );
    console.log(
      "PASS real Valkey container: rendered startup/readiness authentication, UID 999, writable storage and anonymous rejection",
    );
  } finally {
    spawnSync("docker", ["rm", "-fv", name], {
      encoding: "utf8",
      timeout: 30000,
    });
  }
  console.log(
    `PASS ${questions.length} Rancher questions, ${cases.length} deployment modes, ${invalid.length} negative cases; app/chart ${version}`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
