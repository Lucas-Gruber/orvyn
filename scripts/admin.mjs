import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { Pool } = require("pg");
const email = process.argv[2];
if (!email || process.argv.length !== 3) {
  console.error("Usage: pnpm admin:grant user@example.org");
  process.exit(1);
}
const db = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      "UPDATE users SET is_admin=true WHERE email=$1 AND email_verified=true RETURNING id",
      [email.toLowerCase()],
    );
    if (!r.rowCount) throw Error("An existing verified account is required");
    await c.query(
      "INSERT INTO audit_events(actor_id,event) VALUES($1,'admin.granted_via_local_cli')",
      [r.rows[0].id],
    );
    await c.query("COMMIT");
    console.log("Administrator role granted to the verified account");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
} finally {
  await db.end();
}
