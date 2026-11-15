import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { Pool } = require("pg");
import { migrate } from "../apps/api/dist/migrations.js";
const db = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(db);
  console.log("Database migrations applied");
} finally {
  await db.end();
}
