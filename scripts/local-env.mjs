import {
  existsSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
if (!existsSync(".env")) {
  const password = randomBytes(24).toString("hex");
  writeFileSync(
    ".env",
    `ORVYN_DB_PASSWORD=${password}\nDATABASE_URL=postgres://orvyn:${password}@127.0.0.1:5432/orvyn\nORVYN_ORIGIN=http://localhost:3000\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("Created ignored .env with random local database credential");
}

const current = readFileSync(".env", "utf8");
if (!/^ORVYN_ENCRYPTION_KEY=/m.test(current))
  appendFileSync(
    ".env",
    `\nORVYN_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\n`,
  );
if (!/^SMTP_URL=/m.test(current))
  appendFileSync(
    ".env",
    "\nSMTP_URL=smtp://127.0.0.1:1025\nMAIL_FROM=orvyn@localhost.test\n",
  );

if (!/^REDIS_URL=/m.test(current))
  appendFileSync(".env", "\nREDIS_URL=redis://127.0.0.1:6379\n");
if (!/^NUXT_PUBLIC_COLLABORATION_URL=/m.test(current))
  appendFileSync(".env", "NUXT_PUBLIC_COLLABORATION_URL=ws://localhost:3002\n");

const storageEnv = parseEnv(readFileSync(".env", "utf8"));
const accessKey = storageEnv.S3_ACCESS_KEY_ID || "orvyn-development";
const secretKey =
  storageEnv.S3_SECRET_ACCESS_KEY || randomBytes(32).toString("hex");
for (const [key, value] of Object.entries({
  S3_ACCESS_KEY_ID: accessKey,
  S3_SECRET_ACCESS_KEY: secretKey,
  S3_ENDPOINT: "http://127.0.0.1:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "orvyn",
  S3_FORCE_PATH_STYLE: "true",
})) {
  if (!Object.hasOwn(storageEnv, key))
    appendFileSync(".env", `\n${key}=${value}\n`);
}
mkdirSync(".local", { recursive: true, mode: 0o700 });
const configPath = ".local/s3.json";
const config = {
  identities: [
    {
      name: "orvyn-development",
      credentials: [{ accessKey, secretKey }],
      actions: ["Admin", "Read", "List", "Tagging", "Write"],
    },
  ],
};
if (!existsSync(configPath))
  writeFileSync(configPath, JSON.stringify(config), {
    mode: 0o600,
    flag: "wx",
  });
else {
  const existing = JSON.parse(readFileSync(configPath, "utf8"));
  const credentials = existing.identities?.find(
    (i) => i.name === "orvyn-development",
  )?.credentials?.[0];
  if (
    !credentials ||
    credentials.accessKey !== accessKey ||
    credentials.secretKey !== secretKey
  )
    throw Error(
      "Local S3 configuration differs from .env. Preserve and reconcile the existing configuration before restarting storage.",
    );
}
