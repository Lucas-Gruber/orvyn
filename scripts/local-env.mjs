import {
  existsSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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
