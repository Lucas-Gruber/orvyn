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
  {
    version: 5,
    sql: `
ALTER TABLE spaces ADD COLUMN kind text NOT NULL DEFAULT 'personal' CHECK(kind IN ('personal','team'));
ALTER TABLE spaces ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TABLE space_members (
 space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('Admin','Editor','Commenter','Viewer')),
 PRIMARY KEY(space_id,user_id)
);
CREATE INDEX space_members_user ON space_members(user_id);
CREATE TABLE space_invitations (
 token_hash text PRIMARY KEY, space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 email text NOT NULL,role text NOT NULL CHECK(role IN ('Admin','Editor','Commenter','Viewer')),
 invited_by uuid NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pages ADD COLUMN parent_id uuid;
ALTER TABLE pages ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN visibility text NOT NULL DEFAULT 'space' CHECK(visibility IN ('space','restricted'));
ALTER TABLE pages ADD COLUMN deleted_at timestamptz;
ALTER TABLE pages ADD CONSTRAINT pages_space_id_unique UNIQUE(space_id,id);
ALTER TABLE pages ADD CONSTRAINT pages_parent_same_space FOREIGN KEY(space_id,parent_id) REFERENCES pages(space_id,id);
ALTER TABLE pages ADD CONSTRAINT pages_not_own_parent CHECK(parent_id IS DISTINCT FROM id);
CREATE INDEX pages_parent ON pages(space_id,parent_id);
CREATE TABLE page_revisions (
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,version integer NOT NULL,
 title text NOT NULL,document jsonb NOT NULL,author_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(page_id,version)
);
INSERT INTO page_revisions(page_id,version,title,document) SELECT id,version,title,document FROM pages;
CREATE TABLE page_permissions (
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('Admin','Editor','Commenter','Viewer')),
 PRIMARY KEY(page_id,user_id)
);
CREATE FUNCTION orvyn_role_rank(role text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE role WHEN 'Owner' THEN 50 WHEN 'Admin' THEN 40 WHEN 'Editor' THEN 30 WHEN 'Commenter' THEN 20 WHEN 'Viewer' THEN 10 ELSE 0 END
$$;
CREATE FUNCTION orvyn_page_role(target uuid, actor uuid, include_deleted boolean DEFAULT false) RETURNS integer LANGUAGE sql STABLE AS $$
 WITH RECURSIVE ancestry AS (
  SELECT p.id,p.parent_id,p.space_id,p.visibility,p.deleted_at,0 AS depth FROM pages p WHERE p.id=target
  UNION ALL
  SELECT p.id,p.parent_id,p.space_id,p.visibility,p.deleted_at,a.depth+1 FROM pages p JOIN ancestry a ON a.parent_id=p.id WHERE a.depth<63
 ), context AS (
  SELECT s.owner_id,CASE WHEN s.owner_id=actor THEN 50 ELSE orvyn_role_rank(m.role) END AS rank
  FROM spaces s JOIN ancestry a ON a.space_id=s.id AND a.depth=0
  LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=actor
 )
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ancestry WHERE parent_id IS NULL) THEN 0
 WHEN NOT include_deleted AND EXISTS(SELECT 1 FROM ancestry WHERE deleted_at IS NOT NULL) THEN 0
 WHEN (SELECT owner_id FROM context)=actor THEN 50
 ELSE least(coalesce((SELECT rank FROM context),0),coalesce((
 SELECT min(CASE WHEN a.visibility='restricted' THEN coalesce(orvyn_role_rank(p.role),0) ELSE 50 END)
 FROM ancestry a LEFT JOIN page_permissions p ON p.page_id=a.id AND p.user_id=actor
 ),0)) END
$$;
CREATE FUNCTION orvyn_touch_space() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE spaces SET version=version+1 WHERE id=coalesce(NEW.space_id,OLD.space_id); RETURN NULL; END
$$;
CREATE TRIGGER pages_touch_space AFTER INSERT OR UPDATE OR DELETE ON pages FOR EACH ROW EXECUTE FUNCTION orvyn_touch_space();
`,
  },
  {
    version: 6,
    sql: `
CREATE FUNCTION orvyn_upgrade_document(input jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('type','doc','content',CASE WHEN jsonb_array_length(input->'content')=0 THEN '[{"type":"paragraph"}]'::jsonb ELSE
 (SELECT jsonb_agg(CASE WHEN n->>'type'='paragraph' AND n ? 'text' THEN CASE WHEN n->>'text'='' THEN '{"type":"paragraph"}'::jsonb ELSE jsonb_build_object('type','paragraph','content',jsonb_build_array(jsonb_build_object('type','text','text',n->>'text'))) END ELSE n END) FROM jsonb_array_elements(input->'content') AS n) END)
$$;
UPDATE pages SET document=orvyn_upgrade_document(document);
UPDATE page_revisions SET document=orvyn_upgrade_document(document);
ALTER TABLE pages ALTER COLUMN document SET DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}';
ALTER TABLE pages ADD COLUMN document_schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE pages ADD COLUMN title_version integer NOT NULL DEFAULT 1;
CREATE TABLE editor_documents (
 page_id uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 state bytea NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 7,
    sql: `
CREATE OR REPLACE FUNCTION orvyn_touch_space() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.parent_id,NEW.visibility,NEW.deleted_at,NEW.sort_order,NEW.title) IS NOT DISTINCT FROM ROW(OLD.parent_id,OLD.visibility,OLD.deleted_at,OLD.sort_order,OLD.title) THEN RETURN NULL; END IF;
 UPDATE spaces SET version=version+1 WHERE id=coalesce(NEW.space_id,OLD.space_id); RETURN NULL;
END
$$;
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
