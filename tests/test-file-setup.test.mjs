import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const name = "orvyn_suite_0123456789abcdef";
for (const [label, overrides] of [
  ["production mode", { NODE_ENV: "production" }],
  ["remote database", { DATABASE_URL: `postgres://db.example/${name}` }],
  ["ordinary local database", { DATABASE_URL: "postgres://localhost/orvyn" }],
  ["unowned test database", { ORVYN_TEST_DATABASE: "other" }],
])
  test(`test isolation refuses to clear throttle state for ${label}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import=./scripts/test-file-setup.mjs",
        "--input-type=module",
        "--eval",
        "import { test } from 'node:test'; test('guarded fixture', () => {});",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: `postgres://127.0.0.1:1/${name}`,
          ORVYN_TEST_DATABASE: name,
          ...overrides,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout + result.stderr,
      /Test setup requires the runner's local disposable database/,
    );
  });
