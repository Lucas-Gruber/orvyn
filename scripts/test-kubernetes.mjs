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
  await helm([
    "upgrade",
    "--install",
    "s3",
    "infrastructure/helm/orvyn",
    ...args,
  ]);
  const state = await smoke("s3");
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
  await helm([
    "upgrade",
    "s3",
    "infrastructure/helm/orvyn",
    ...args,
    "--set",
    "api.replicaCount=2",
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
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) {
    const kind = process.env.KIND_BIN || join(temp, "kind");
    await run(kind, ["delete", "cluster", "--name", cluster]);
  }
  await rm(temp, { recursive: true, force: true });
}
