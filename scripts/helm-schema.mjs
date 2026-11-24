import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
const file = new URL("../infrastructure/helm/orvyn/", import.meta.url);
const values = YAML.parse(await readFile(new URL("values.yaml", file), "utf8"));
const string = { type: "string" };
const dns = {
  type: "string",
  maxLength: 253,
  pattern: "^$|^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$",
};
const key = { type: "string", minLength: 1, pattern: "^[A-Za-z0-9._-]+$" };
const quantity = {
  type: "string",
  pattern: "^[0-9]+(\\.[0-9]+)?(m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$",
};
const mapping = { type: "object", additionalProperties: string };
const defs = {
  image: {
    type: "object",
    additionalProperties: false,
    required: ["repository", "tag", "digest", "pullPolicy"],
    properties: {
      repository: {
        type: "string",
        minLength: 1,
        pattern: "^[a-z0-9][a-z0-9._:/-]*$",
      },
      tag: {
        type: "string",
        pattern: "^$|^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$",
      },
      digest: { type: "string", pattern: "^$|^sha256:[a-f0-9]{64}$" },
      pullPolicy: { enum: ["Always", "IfNotPresent", "Never"] },
    },
  },
  persistence: {
    type: "object",
    additionalProperties: false,
    required: [
      "enabled",
      "existingClaim",
      "storageClass",
      "accessMode",
      "size",
      "annotations",
      "retain",
    ],
    properties: {
      enabled: { type: "boolean" },
      existingClaim: dns,
      storageClass: { type: "string", pattern: "^$|^-$|^[a-z0-9][a-z0-9.-]*$" },
      accessMode: { enum: ["ReadWriteOnce", "ReadWriteMany"] },
      size: { type: "string", pattern: "^[1-9][0-9]*(Mi|Gi|Ti)$" },
      annotations: mapping,
      retain: { type: "boolean" },
    },
    allOf: [
      {
        if: { properties: { enabled: { const: false } } },
        then: { properties: { existingClaim: { const: "" } } },
      },
    ],
  },
  resources: {
    type: "object",
    additionalProperties: false,
    properties: {
      requests: { type: "object", additionalProperties: quantity },
      limits: { type: "object", additionalProperties: quantity },
    },
  },
  probe: {
    type: "object",
    additionalProperties: false,
    properties: {
      httpGet: {
        type: "object",
        required: ["path", "port"],
        properties: {
          path: { type: "string", pattern: "^/" },
          port: {
            oneOf: [{ type: "integer", minimum: 1, maximum: 65535 }, string],
          },
          scheme: { enum: ["HTTP", "HTTPS"] },
          httpHeaders: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "value"],
              properties: { name: string, value: string },
            },
          },
        },
      },
      tcpSocket: {
        type: "object",
        required: ["port"],
        properties: {
          port: {
            oneOf: [{ type: "integer", minimum: 1, maximum: 65535 }, string],
          },
        },
      },
      exec: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "array", minItems: 1, items: string } },
      },
      initialDelaySeconds: { type: "integer", minimum: 0 },
      periodSeconds: { type: "integer", minimum: 1 },
      timeoutSeconds: { type: "integer", minimum: 1 },
      successThreshold: { type: "integer", minimum: 1 },
      failureThreshold: { type: "integer", minimum: 1 },
    },
    oneOf: [
      { maxProperties: 0 },
      {
        required: ["httpGet"],
        not: { anyOf: [{ required: ["tcpSocket"] }, { required: ["exec"] }] },
      },
      {
        required: ["tcpSocket"],
        not: { anyOf: [{ required: ["httpGet"] }, { required: ["exec"] }] },
      },
      {
        required: ["exec"],
        not: {
          anyOf: [{ required: ["httpGet"] }, { required: ["tcpSocket"] }],
        },
      },
    ],
  },
  podSecurityContext: {
    type: "object",
    properties: {
      runAsNonRoot: { type: "boolean" },
      runAsUser: { type: "integer", minimum: 1 },
      runAsGroup: { type: "integer", minimum: 1 },
      fsGroup: { type: "integer", minimum: 1 },
      fsGroupChangePolicy: { enum: ["OnRootMismatch", "Always"] },
      supplementalGroups: {
        type: "array",
        items: { type: "integer", minimum: 1 },
      },
      seccompProfile: {
        type: "object",
        required: ["type"],
        properties: {
          type: { enum: ["RuntimeDefault", "Localhost"] },
          localhostProfile: string,
        },
      },
    },
  },
  securityContext: {
    type: "object",
    properties: {
      allowPrivilegeEscalation: { const: false },
      privileged: { const: false },
      readOnlyRootFilesystem: { type: "boolean" },
      runAsNonRoot: { type: "boolean" },
      runAsUser: { type: "integer", minimum: 1 },
      runAsGroup: { type: "integer", minimum: 1 },
      capabilities: {
        type: "object",
        properties: {
          drop: { type: "array", items: string },
          add: { type: "array", maxItems: 0 },
        },
      },
    },
  },
};
function infer(value, path = []) {
  const name = path.at(-1);
  if (name === "podLabels")
    return {
      ...mapping,
      propertyNames: {
        not: { pattern: "^(app\\.kubernetes\\.io/|orvyn\\.io/)" },
      },
    };
  if (name === "podAnnotations")
    return { ...mapping, propertyNames: { not: { const: "checksum/config" } } };
  if (name === "image") return { $ref: "#/definitions/image" };
  if (name === "persistence") return { $ref: "#/definitions/persistence" };
  if (name === "resources") return { $ref: "#/definitions/resources" };
  if (/Probe$/.test(name)) return { $ref: "#/definitions/probe" };
  if (["podSecurityContext", "securityContext"].includes(name))
    return { $ref: "#/definitions/" + name };
  if (
    ["nodeSelector", "podLabels", "podAnnotations", "annotations"].includes(
      name,
    )
  )
    return mapping;
  if (name === "affinity") return { type: "object" };
  if (name === "tolerations")
    return {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: string,
          operator: { enum: ["Exists", "Equal"] },
          value: string,
          effect: { enum: ["NoSchedule", "PreferNoSchedule", "NoExecute"] },
          tolerationSeconds: { type: "integer", minimum: 0 },
        },
      },
    };
  if (name === "imagePullSecrets")
    return {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { ...dns, minLength: 1 } },
      },
    };
  if (Array.isArray(value)) return { type: "array", items: string };
  if (value && typeof value === "object")
    return {
      type: "object",
      additionalProperties: false,
      required: Object.keys(value),
      properties: Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, infer(v, [...path, k])]),
      ),
    };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number")
    return {
      type: "integer",
      minimum: name === "replicaCount" ? 1 : 0,
      ...(name === "replicaCount" ? { maximum: 100 } : {}),
      ...(name === "maxUploadBytes" ? { minimum: 1, maximum: 104857600 } : {}),
      ...(name === "port" ? { minimum: 1, maximum: 65535 } : {}),
    };
  if (
    name === "existingSecret" ||
    name === "existingEncryptionSecret" ||
    name === "nameOverride" ||
    name === "fullnameOverride" ||
    name === "secretName"
  )
    return { ...dns };
  if (
    /SecretKey$/.test(name) ||
    name === "secretKey" ||
    name === "encryptionSecretKey"
  )
    return { ...key };
  return { ...string };
}
const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Orvyn deployment values",
  ...infer(values),
  definitions: defs,
  allOf: [],
};
function at(path, rule) {
  return path
    .split(".")
    .reverse()
    .reduce(
      (inner, p) => ({ properties: { [p]: inner }, required: [p] }),
      rule,
    );
}
function property(path) {
  return path.split(".").reduce((s, p) => s.properties[p], schema);
}
function rule(path, condition, then) {
  schema.allOf.push({ if: at(path, condition), then });
}
const nonempty = { type: "string", minLength: 1 };
const supplied = (value, reference) => ({
  anyOf: [at(value, nonempty), at(reference, nonempty)],
});
Object.assign(property("global.encryptionKey"), {
  pattern: "^$|^[a-fA-F0-9]{64}$",
});
for (const name of ["nameOverride", "fullnameOverride"])
  Object.assign(property(name), {
    maxLength: name === "nameOverride" ? 40 : 45,
    pattern: "^$|^[a-z]([a-z0-9-]*[a-z0-9])?$",
  });
Object.assign(property("global.origin"), { pattern: "^https://[^/?#@]+$" });
Object.assign(property("storage.driver"), { enum: ["local", "s3"] });
Object.assign(property("storage.local.path"), {
  pattern: "^/[^\\x00]*$",
  minLength: 2,
});
Object.assign(property("storage.s3.bucket"), {
  minLength: 3,
  maxLength: 63,
  pattern: "^[a-z0-9][a-z0-9.-]*[a-z0-9]$",
});
Object.assign(property("storage.s3.region"), { minLength: 1 });
Object.assign(property("sso.oidc.clientAuthMethod"), {
  enum: ["none", "client_secret_post", "client_secret_basic"],
});
Object.assign(property("ingress.tls.issuerKind"), {
  enum: ["Issuer", "ClusterIssuer"],
});
Object.assign(property("smtp.from"), {
  minLength: 3,
  pattern: "^[^\\r\\n]+@[^\\r\\n]+$",
});
for (const p of ["api.service.type", "collaboration.service.type"])
  Object.assign(property(p), { const: "ClusterIP" });
Object.assign(property("web.service.type"), {
  enum: ["ClusterIP", "NodePort", "LoadBalancer"],
});
rule(
  "global.generateSecrets",
  { const: false },
  {
    allOf: [
      supplied("global.encryptionKey", "global.existingEncryptionSecret"),
      {
        if: at("postgresql.enabled", { const: true }),
        then: supplied(
          "postgresql.auth.password",
          "postgresql.auth.existingSecret",
        ),
      },
      {
        if: at("valkey.enabled", { const: true }),
        then: supplied("valkey.auth.password", "valkey.auth.existingSecret"),
      },
      {
        if: at("storage.driver", { const: "s3" }),
        then: {
          allOf: [
            supplied("storage.s3.accessKeyId", "storage.s3.existingSecret"),
            supplied("storage.s3.secretAccessKey", "storage.s3.existingSecret"),
          ],
        },
      },
    ],
  },
);
for (const [enabled, section, pattern] of [
  ["postgresql.enabled", "externalPostgresql", "^postgres(ql)?://"],
  ["valkey.enabled", "externalValkey", "^rediss?://"],
]) {
  rule(
    enabled,
    { const: false },
    {
      allOf: [
        supplied(section + ".url", section + ".existingSecret"),
        {
          if: at(section + ".existingSecret", { const: "" }),
          then: at(section + ".url", { pattern }),
        },
      ],
    },
  );
  rule(
    enabled,
    { const: true },
    {
      allOf: [
        at(section + ".url", { const: "" }),
        at(section + ".existingSecret", { const: "" }),
      ],
    },
  );
}
schema.allOf.push(supplied("smtp.url", "smtp.existingSecret"));
rule(
  "smtp.existingSecret",
  { const: "" },
  at("smtp.url", { pattern: "^smtps?://" }),
);
schema.allOf.push({
  if: {
    allOf: [
      at("storage.driver", { const: "s3" }),
      at("storage.s3.internal.enabled", { const: false }),
    ],
  },
  then: {
    allOf: [
      at("storage.s3.external.endpoint", { pattern: "^https?://[^\\s]+$" }),
      supplied("storage.s3.accessKeyId", "storage.s3.existingSecret"),
      supplied("storage.s3.secretAccessKey", "storage.s3.existingSecret"),
    ],
  },
});
rule(
  "sso.oidc.enabled",
  { const: true },
  {
    allOf: [
      at("sso.oidc.issuer", { pattern: "^https://[^?#@\\s]+$" }),
      at("sso.oidc.clientId", nonempty),
      at("sso.oidc.name", nonempty),
      at("sso.oidc.scopes", { pattern: "(^| )openid( |$)" }),
      {
        if: at("sso.oidc.clientAuthMethod", { const: "none" }),
        then: {
          allOf: [
            at("sso.oidc.clientSecret", { const: "" }),
            at("sso.oidc.existingSecret", { const: "" }),
          ],
        },
        else: supplied("sso.oidc.clientSecret", "sso.oidc.existingSecret"),
      },
    ],
  },
);
schema.allOf.push({
  if: {
    allOf: [
      at("ingress.enabled", { const: true }),
      at("ingress.tls.enabled", { const: true }),
    ],
  },
  then: at("ingress.tls.secretName", nonempty),
});
for (const [value, ref] of [
  ["global.encryptionKey", "global.existingEncryptionSecret"],
  ["postgresql.auth.password", "postgresql.auth.existingSecret"],
  ["valkey.auth.password", "valkey.auth.existingSecret"],
  ["externalPostgresql.url", "externalPostgresql.existingSecret"],
  ["externalValkey.url", "externalValkey.existingSecret"],
  ["storage.s3.accessKeyId", "storage.s3.existingSecret"],
  ["storage.s3.secretAccessKey", "storage.s3.existingSecret"],
  ["smtp.url", "smtp.existingSecret"],
  ["sso.oidc.clientSecret", "sso.oidc.existingSecret"],
])
  rule(ref, nonempty, at(value, { const: "" }));
const output = JSON.stringify(schema, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(new URL("values.schema.json", file), "utf8")) !== output)
    throw Error("Run node scripts/helm-schema.mjs to update the chart schema");
} else await writeFile(new URL("values.schema.json", file), output);
