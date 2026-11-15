import { Pool } from "pg";
export const migrations = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS auth_limits(key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password_hash text NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), name text NOT NULL);
      CREATE INDEX IF NOT EXISTS spaces_owner ON spaces(owner_id);
      CREATE TABLE IF NOT EXISTS pages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, title text NOT NULL, document jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}', version integer NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS pages_space ON pages(space_id);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id ON sessions(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE account_tokens (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK (purpose IN ('verify-email','reset-password')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user ON account_tokens(user_id,purpose);
CREATE TABLE mail_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_outbox_pending ON mail_outbox(available_at) WHERE sent_at IS NULL;
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oidc_providers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 issuer text UNIQUE NOT NULL, client_id text NOT NULL, encrypted_secret text,
 scopes text NOT NULL DEFAULT 'openid email profile', enabled boolean NOT NULL DEFAULT false,
 auto_provision boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_identities (
 provider_id uuid NOT NULL REFERENCES oidc_providers(id), subject text NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(provider_id,subject)
);
CREATE TABLE oidc_flows (
 state_hash text PRIMARY KEY, provider_id uuid NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
 browser_hash text NOT NULL, encrypted_verifier text NOT NULL, nonce text NOT NULL,
 expires_at timestamptz NOT NULL
);`,
  },
  {
    version: 3,
    sql: `ALTER TABLE sessions ADD COLUMN provider_id uuid REFERENCES oidc_providers(id);`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE oidc_providers ADD COLUMN config_version integer NOT NULL DEFAULT 1;
ALTER TABLE oidc_flows ADD COLUMN provider_version integer NOT NULL DEFAULT 1;
`,
  },
] as const;

export async function migrate(pool: Pool, target = migrations.at(-1)!.version) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(782901)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY)",
    );
    const applied = new Set(
      (
        await c.query("SELECT version FROM schema_migrations ORDER BY version")
      ).rows.map((r) => r.version),
    );
    if ([...applied].some((v) => !migrations.some((m) => m.version === v)))
      throw Error("Database schema is newer than this application");
    for (const migration of migrations) {
      if (migration.version > target || applied.has(migration.version))
        continue;
      await c.query(migration.sql);
      await c.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        migration.version,
      ]);
    }
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
