import { before } from "node:test";
import { createRequire } from "node:module";

// Files run sequentially against one disposable database. Each file gets its
// own throttle budget, while all requests inside that file use the real limits.
before(async () => {
  const address = new URL(process.env.DATABASE_URL);
  const name = address.pathname.slice(1);
  if (
    process.env.NODE_ENV !== "test" ||
    !["postgres:", "postgresql:"].includes(address.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) ||
    !/^orvyn_suite_[a-f0-9]{16}$/.test(name) ||
    process.env.ORVYN_TEST_DATABASE !== name
  )
    throw Error("Test setup requires the runner's local disposable database");
  const require = createRequire(
    new URL("../apps/api/package.json", import.meta.url),
  );
  const { Pool } = require("pg");
  const db = new Pool({ connectionString: address.toString() });
  try {
    await db.query("DELETE FROM auth_limits");
  } finally {
    await db.end();
  }
});
