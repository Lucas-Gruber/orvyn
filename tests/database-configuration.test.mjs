import test from "node:test";
import assert from "node:assert/strict";
import { databaseConfiguration } from "../packages/auth/dist/index.js";

test("database URLs preserve TLS options and split password fields remain literal", () => {
  const connectionString =
    "postgresql://a:b@db/orvyn?sslmode=verify-full&sslrootcert=%2Fetc%2Fca.crt";
  assert.deepEqual(databaseConfiguration({ DATABASE_URL: connectionString }), {
    connectionString,
  });
  const password = "spaces & @ : / ? # and +";
  assert.deepEqual(
    databaseConfiguration({
      PGHOST: "db",
      PGUSER: "orvyn",
      PGDATABASE: "notes",
      PGPASSWORD: password,
    }),
    { host: "db", user: "orvyn", database: "notes", password, port: 5432 },
  );
  assert.throws(() => databaseConfiguration({}), /Configure DATABASE_URL/);
  assert.throws(
    () => databaseConfiguration({ DATABASE_URL: "https://a:b@example.test" }),
    /PostgreSQL URL/,
  );
  assert.throws(
    () =>
      databaseConfiguration({
        PGHOST: "db",
        PGUSER: "orvyn",
        PGDATABASE: "notes",
        PGPASSWORD: password,
        PGPORT: "65536",
      }),
    /PGPORT/,
  );
});
