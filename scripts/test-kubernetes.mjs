import { execFile } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { root } from "./release.mjs";
import { helmImage } from "./helm-tools.mjs";
const temp = await mkdtemp(join(tmpdir(), "orvyn-k8s-"));
const cluster = "orvyn-chart-" + process.pid,
  node = cluster + "-control-plane",
  namespace = "orvyn-chart";
let created = false;
let diagnosticTimer,
  diagnosticWork = Promise.resolve(),
  diagnosticBusy = false;
const diagnostics = new Map();
let redactions = [];
const redact = (value) => {
  let text = String(value);
  for (const secret of redactions) text = text.replaceAll(secret, "[redacted]");
  return text;
};
async function run(command, args, input) {
  // execFile has no stdin option; write through its pipe without shell interpolation.
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 600000,
      },
      (error, stdout, stderr) =>
        error
          ? reject(Error(command + " failed: " + stderr.slice(-8000)))
          : resolve(stdout),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
const kubectl = (args, input) =>
  run(
    "docker",
    [
      "exec",
      "-i",
      node,
      "kubectl",
      "--kubeconfig=/etc/kubernetes/admin.conf",
      ...args,
    ],
    input,
  );
const helm = (args) =>
  run("docker", [
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    "kind",
    "-v",
    `${root}:/repo:ro`,
    "-v",
    `${temp}:/checks:ro`,
    "-e",
    "KUBECONFIG=/checks/kubeconfig",
    "-w",
    "/repo",
    helmImage,
    ...args,
  ]);
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
async function observeStartup() {
  const secrets = JSON.parse(
    await kubectl(["-n", namespace, "get", "secrets", "-o", "json"]),
  );
  redactions = [
    ...new Set([
      ...redactions,
      ...secrets.items
        .flatMap((item) =>
          Object.values(item.data || {}).map((value) =>
            Buffer.from(value, "base64").toString(),
          ),
        )
        .filter((value) => value.length >= 8),
    ]),
  ];
  const pods = JSON.parse(
    await kubectl(["-n", namespace, "get", "pods", "-o", "json"]),
  );
  for (const pod of pods.items) {
    if (pod.metadata.deletionTimestamp) continue;
    const prefix = pod.metadata.name + "/";
    for (const container of [
      ...(pod.status.initContainerStatuses || []),
      ...(pod.status.containerStatuses || []),
    ]) {
      const key = prefix + container.name;
      if (container.ready || container.state?.terminated?.exitCode === 0) {
        diagnostics.delete(key);
        continue;
      }
      const condition = pod.status.conditions?.find(
        (value) => value.reason === "Unschedulable",
      );
      const state =
        container.state?.waiting ||
        container.lastState?.terminated ||
        container.state?.terminated;
      let detail = [
        key,
        pod.status.phase,
        condition?.message,
        state?.reason,
        state?.message,
      ]
        .filter(Boolean)
        .join(" ");
      if (container.state?.running || container.lastState?.terminated) {
        try {
          detail +=
            "\n" +
            (await kubectl([
              "-n",
              namespace,
              "logs",
              pod.metadata.name,
              "-c",
              container.name,
              "--tail=12",
            ]));
        } catch {}
      }
      diagnostics.set(key, redact(detail).slice(-1500));
      if (diagnostics.size > 12)
        diagnostics.delete(diagnostics.keys().next().value);
    }
    if (!pod.status.containerStatuses?.length) {
      const condition = pod.status.conditions?.find(
        (value) => value.reason === "Unschedulable",
      );
      if (condition)
        diagnostics.set(prefix + "scheduling", redact(condition.message));
    }
  }
}
const smoke = async (release, state) => {
  const code = `import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
    const origin='https://orvyn.example.test'; const previous=${JSON.stringify(state || null)};
    let cookie=previous?.cookie;
    async function request(path,method='GET',body){const r=await fetch('http://127.0.0.1:3000/api/v1/'+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});if(!r.ok)throw Error(path+' HTTP '+r.status);return r;}
    if(previous){const r=await request('files/'+previous.file+'/download');assert.equal(await r.text(),'Persistent Kubernetes attachment');console.log(JSON.stringify(previous));}
    else{const registered=await request('auth/register','POST',{email:randomUUID()+'@example.test',password:randomUUID()});cookie=registered.headers.getSetCookie().find(c=>c.startsWith('orvyn_session=')).split(';')[0];
      const space=await(await request('spaces','POST',{name:'Kubernetes smoke'})).json();const page=await(await request('spaces/'+space.id+'/pages','POST',{title:'Persistent test document'})).json();
      const body=new FormData();body.append('file',new Blob(['Persistent Kubernetes attachment']),'test.txt');const file=await(await request('pages/'+page.id+'/files','POST',body)).json();
      assert.equal(await(await request('files/'+file.id+'/download')).text(),'Persistent Kubernetes attachment');
      const anonymous=await fetch('http://127.0.0.1:3000/api/v1/files/'+file.id+'/download');assert.equal(anonymous.status,401);console.log(JSON.stringify({cookie,file:file.id}));}`;
  return JSON.parse(
    await kubectl(
      [
        "-n",
        namespace,
        "exec",
        "-i",
        "deployment/" + release + "-orvyn-web",
        "--",
        "node",
        "--input-type=module",
      ],
      code,
    ),
  );
};
try {
  const kind = process.env.KIND_BIN || join(temp, "kind");
  if (!process.env.KIND_BIN) {
    const response = await fetch(
      "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64",
    );
    if (!response.ok) throw Error("Cannot download pinned Kind");
    const binary = Buffer.from(await response.arrayBuffer());
    if (
      fingerprint(binary) !==
      "aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d"
    )
      throw Error("Kind binary checksum mismatch");
    await writeFile(kind, binary);
    await chmod(kind, 0o700);
  }
  const existing = (await run(kind, ["get", "clusters"])).trim().split(/\s+/);
  if (existing.includes(cluster))
    throw Error("Refusing to reuse an existing cluster");
  await run(kind, [
    "create",
    "cluster",
    "--name",
    cluster,
    "--kubeconfig",
    join(temp, "external-kubeconfig"),
    "--wait",
    "120s",
  ]);
  created = true;
  await writeFile(
    join(temp, "kubeconfig"),
    await run(kind, ["get", "kubeconfig", "--name", cluster, "--internal"]),
    { mode: 0o600 },
  );
  for (const component of ["web", "api", "worker", "collaboration"])
    await run(kind, [
      "load",
      "docker-image",
      `orvyn/${component}:ci`,
      "--name",
      cluster,
    ]);
  await kubectl(["create", "namespace", namespace]);
  const storageClasses = JSON.parse(
    await kubectl(["get", "storageclasses", "-o", "json"]),
  );
  const defaultClass = storageClasses.items.find(
    (s) =>
      s.metadata.annotations?.[
        "storageclass.kubernetes.io/is-default-class"
      ] === "true",
  );
  if (!defaultClass)
    throw Error("The test cluster needs a default StorageClass");
  await kubectl(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: { name: "orvyn-backup-delayed" },
      provisioner: defaultClass.provisioner,
      parameters: defaultClass.parameters,
      reclaimPolicy: "Delete",
      volumeBindingMode: "WaitForFirstConsumer",
      allowedTopologies: defaultClass.allowedTopologies,
    }),
  );
  await kubectl(
    ["apply", "-f", "-"],
    YAML.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "mailpit", namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "mailpit" } },
        template: {
          metadata: { labels: { app: "mailpit" } },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: "mailpit",
                image:
                  "axllent/mailpit@sha256:aef2aacc11f075ec0fb6874275ee4a421e688e11a96ebb296134d1735c7761ce",
                ports: [{ containerPort: 1025 }],
                resources: {
                  requests: { cpu: "25m", memory: "32Mi" },
                  limits: { memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    }) +
      "---\n" +
      YAML.stringify({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "mailpit", namespace },
        spec: {
          selector: { app: "mailpit" },
          ports: [{ port: 1025, targetPort: 1025 }],
        },
      }),
  );
  const base = {
    global: {
      origin: "https://orvyn.example.test",
      imageRegistry: "docker.io",
    },
    ingress: { enabled: false },
    smtp: { url: "smtp://mailpit:1025", from: "orvyn@example.test" },
    backup: {
      enabled: true,
      suspend: true,
      persistence: { storageClass: "orvyn-backup-delayed" },
    },
  };
  for (const component of ["web", "api", "worker", "collaboration"])
    base[component] = {
      image: {
        repository: `orvyn/${component}`,
        tag: "ci",
        pullPolicy: "Never",
      },
    };
  await writeFile(join(temp, "values.yaml"), YAML.stringify(base));
  const args = [
    "--namespace",
    namespace,
    "--wait",
    "--wait-for-jobs",
    "--atomic",
    "--timeout",
    "6m",
    "-f",
    "/checks/values.yaml",
  ];
  // Capture before --atomic can remove failed Pods; retain no raw credential logs.
  diagnosticTimer = setInterval(() => {
    if (diagnosticBusy) return;
    diagnosticBusy = true;
    diagnosticWork = observeStartup()
      .catch(() => {})
      .finally(() => {
        diagnosticBusy = false;
      });
  }, 3000);
  diagnosticTimer.unref();
  await helm([
    "upgrade",
    "--install",
    "s3",
    "infrastructure/helm/orvyn",
    ...args,
  ]);
  const state = await smoke("s3");
  const initialized = JSON.parse(
    await kubectl(["-n", namespace, "get", "jobs", "-o", "json"]),
  );
  if (
    !initialized.items.some(
      (job) =>
        job.metadata.name.includes("-backup-volume-") &&
        job.status.succeeded === 1,
    )
  )
    throw Error(
      "The delayed-binding backup volume was not initialized before installation completed",
    );
  console.log(
    "PASS Kubernetes: suspended backup CronJob with WaitForFirstConsumer PVC and credential-free volume initialization",
  );
  const secretBefore = JSON.parse(
    await kubectl([
      "-n",
      namespace,
      "get",
      "secret",
      "s3-orvyn-secrets",
      "-o",
      "json",
    ]),
  ).data;
  const secretHash = fingerprint(
    JSON.stringify(Object.entries(secretBefore).sort()),
  );
  console.log(
    "PASS Kubernetes: atomic internal PostgreSQL, Valkey, SeaweedFS install; readiness, private upload and download",
  );
  await kubectl([
    "-n",
    namespace,
    "create",
    "job",
    "database-backup-smoke",
    "--from=cronjob/s3-orvyn-db-backup",
  ]);
  await kubectl([
    "-n",
    namespace,
    "wait",
    "--for=condition=complete",
    "job/database-backup-smoke",
    "--timeout=180s",
  ]);
  const backupLog = await kubectl([
    "-n",
    namespace,
    "logs",
    "job/database-backup-smoke",
  ]);
  const snapshot = backupLog.match(
    /Database snapshot completed: (postgresql-[0-9]{8}T[0-9]{15}Z-[A-Za-z0-9]{8})/,
  );
  if (!snapshot)
    throw Error(
      "The Kubernetes database backup did not publish a completed snapshot",
    );
  const cron = JSON.parse(
    await kubectl([
      "-n",
      namespace,
      "get",
      "cronjob",
      "s3-orvyn-db-backup",
      "-o",
      "json",
    ]),
  );
  const restore = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "database-restore-smoke", namespace },
    spec: structuredClone(cron.spec.jobTemplate.spec),
  };
  const restoreContainer = restore.spec.template.spec.containers[0];
  restoreContainer.command = ["/bin/bash", "/scripts/restore-postgresql.sh"];
  restoreContainer.env.push(
    { name: "ORVYN_RESTORE_BACKUP", value: snapshot[1] },
    { name: "ORVYN_RESTORE_DATABASE", value: "orvyn_restore_kubernetes" },
  );
  await kubectl(["create", "-f", "-"], JSON.stringify(restore));
  await kubectl([
    "-n",
    namespace,
    "wait",
    "--for=condition=complete",
    "job/database-restore-smoke",
    "--timeout=180s",
  ]);
  if (!/^[0-9a-f-]{36}$/.test(state.file))
    throw Error("Invalid Kubernetes fixture file ID");
  const recovered = await kubectl([
    "-n",
    namespace,
    "exec",
    "statefulset/s3-orvyn-postgresql",
    "--",
    "psql",
    "-X",
    "--no-password",
    "-U",
    "orvyn",
    "-d",
    "orvyn_restore_kubernetes",
    "-At",
    "-c",
    `SELECT count(*) FROM files WHERE id='${state.file}'`,
  ]);
  if (recovered.trim() !== "1")
    throw Error(
      "The recovered Kubernetes database is missing its private attachment metadata",
    );
  await smoke("s3", state);
  console.log(
    "PASS Kubernetes: real CronJob archive on retained PVC, non-root isolated restore Job and preserved source attachment",
  );
  await helm([
    "upgrade",
    "s3",
    "infrastructure/helm/orvyn",
    ...args,
    "--set",
    "api.replicaCount=2",
    "--set",
    "auth.registration.enabled=false",
    "--set",
    "auth.registration.allowedEmailDomains[0]=company.example",
    "--set",
    "sso.oidc.enabled=true",
    "--set",
    "sso.oidc.issuer=https://login.example.test",
    "--set",
    "sso.oidc.clientId=orvyn",
    "--set",
    "sso.oidc.clientAuthMethod=none",
  ]);
  const after = JSON.parse(
    await kubectl([
      "-n",
      namespace,
      "get",
      "secret",
      "s3-orvyn-secrets",
      "-o",
      "json",
    ]),
  ).data;
  if (fingerprint(JSON.stringify(Object.entries(after).sort())) !== secretHash)
    throw Error("Generated secrets changed on upgrade");
  await smoke("s3", state);
  const registration = await kubectl([
    "-n",
    namespace,
    "exec",
    "deployment/s3-orvyn-web",
    "--",
    "node",
    "-e",
    "(async()=>{const options=await(await fetch('http://127.0.0.1:3000/api/v1/auth/options')).json();if(options.registration.enabled!==false)process.exit(1);const response=await fetch('http://127.0.0.1:3000/api/v1/auth/register',{method:'POST',headers:{Origin:'https://orvyn.example.test','Content-Type':'application/json'},body:JSON.stringify({email:crypto.randomUUID()+'@company.example',password:crypto.randomUUID()})});if(response.status!==403)process.exit(1);console.log('Local registration disabled; existing access preserved')})()",
  ]);
  console.log("PASS Kubernetes: " + registration.trim());
  const providers = JSON.parse(
    await kubectl([
      "-n",
      namespace,
      "exec",
      "deployment/s3-orvyn-web",
      "--",
      "node",
      "-e",
      "fetch('http://127.0.0.1:3000/api/v1/oidc/providers').then(r=>r.text()).then(console.log)",
    ]),
  );
  if (providers.length !== 1)
    throw Error("OIDC configuration hook did not apply");
  console.log(
    "PASS Kubernetes: two API replicas, migration/configuration upgrade, OIDC hook, stable secrets and existing attachment",
  );
  await helm([
    "rollback",
    "s3",
    "1",
    "--namespace",
    namespace,
    "--wait",
    "--wait-for-jobs",
    "--timeout",
    "6m",
  ]);
  await smoke("s3", state);
  console.log(
    "PASS Kubernetes: configuration rollback and preserved authentication/attachment",
  );
  await helm([
    "upgrade",
    "--install",
    "local",
    "infrastructure/helm/orvyn",
    ...args,
    "--set",
    "storage.driver=local",
  ]);
  const local = await smoke("local");
  await helm([
    "upgrade",
    "local",
    "infrastructure/helm/orvyn",
    ...args,
    "--set",
    "storage.driver=local",
    "--set",
    "global.secretRevision=upgrade-test",
  ]);
  await smoke("local", local);
  const pods = JSON.parse(
    await kubectl([
      "-n",
      namespace,
      "get",
      "pods",
      "-l",
      "app.kubernetes.io/instance=local,orvyn.io/local-storage=true",
      "-o",
      "json",
    ]),
  );
  if (
    new Set(
      pods.items
        .filter((p) => p.status.phase === "Running")
        .map((p) => p.spec.nodeName),
    ).size !== 1
  )
    throw Error("ReadWriteOnce attachment pods are not colocated");
  console.log(
    "PASS Kubernetes: shared local PVC, UID permissions, colocated API/worker, upgrade and preserved attachment",
  );
} catch (error) {
  clearInterval(diagnosticTimer);
  await diagnosticWork;
  if (created) {
    try {
      console.error(await kubectl(["-n", namespace, "get", "pods"]));
      console.error(
        await kubectl([
          "-n",
          namespace,
          "get",
          "events",
          "--sort-by=.lastTimestamp",
        ]),
      );
    } catch {}
  }
  const message = redact(
    error.message + "\n" + [...diagnostics.values()].join("\n"),
  );
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true")
    console.error(
      "::error title=Kubernetes install or upgrade failed::" +
        message
          .slice(-3500)
          .replace(/%/g, "%25")
          .replace(/\r/g, "%0D")
          .replace(/\n/g, "%0A"),
    );
  process.exitCode = 1;
} finally {
  clearInterval(diagnosticTimer);
  await diagnosticWork;
  if (created) {
    const kind = process.env.KIND_BIN || join(temp, "kind");
    await run(kind, ["delete", "cluster", "--name", cluster]);
  }
  await rm(temp, { recursive: true, force: true });
}
