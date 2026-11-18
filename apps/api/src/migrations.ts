import { Pool, type PoolClient } from "pg";
import { documentReferences } from "@orvyn/editor/links";
import { templateMigration } from "./databases/templates/migration.js";
import { searchMigration } from "./search-migration.js";
import { crossSpaceRelationMigration } from "./databases/cross-space-migration.js";
import { reciprocalRelationMigration } from "./databases/reciprocal-migration.js";
import { multiHopRollupMigration } from "./databases/multi-hop-migration.js";
import { propertySearchMigration } from "./property-search-migration.js";
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
  {
    version: 8,
    sql: `
CREATE TABLE files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),page_id uuid NOT NULL REFERENCES pages(id),
 object_key text UNIQUE NOT NULL,filename text NOT NULL,media_type text NOT NULL,size integer NOT NULL CHECK(size>=0),
 uploaded_by uuid NOT NULL REFERENCES users(id),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz
);
CREATE INDEX files_page ON files(page_id) WHERE state='ready';
CREATE INDEX files_pending ON files(created_at) WHERE state='pending';
`,
  },
  {
    version: 9,
    sql: `
ALTER TABLE pages ADD COLUMN kind text NOT NULL DEFAULT 'page' CHECK(kind IN ('page','database','record','whiteboard'));
ALTER TABLE pages ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pages ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pages ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE pages ADD COLUMN last_edited_by uuid REFERENCES users(id);
UPDATE pages p SET created_at=coalesce((SELECT min(created_at) FROM page_revisions r WHERE r.page_id=p.id),now()),updated_at=coalesce((SELECT max(created_at) FROM page_revisions r WHERE r.page_id=p.id),now()),created_by=coalesce((SELECT author_id FROM page_revisions r WHERE r.page_id=p.id AND author_id IS NOT NULL ORDER BY version LIMIT 1),(SELECT owner_id FROM spaces s WHERE s.id=p.space_id)),last_edited_by=coalesce((SELECT author_id FROM page_revisions r WHERE r.page_id=p.id AND author_id IS NOT NULL ORDER BY version DESC LIMIT 1),(SELECT owner_id FROM spaces s WHERE s.id=p.space_id));
CREATE FUNCTION orvyn_page_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER pages_timestamp BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION orvyn_page_timestamp();
CREATE TABLE databases (
 page_id uuid PRIMARY KEY REFERENCES pages(id),schema_version integer NOT NULL DEFAULT 1
);
CREATE TABLE database_properties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),database_id uuid NOT NULL REFERENCES databases(page_id),
 name text NOT NULL,type text NOT NULL CHECK(type IN ('Title','Text','Number','Select','MultiSelect','Status','Date','Checkbox','URL','Email','Phone','Person','Files','Relation','Formula','Rollup','CreatedTime','CreatedBy','LastEditedTime','LastEditedBy')),
 config jsonb NOT NULL DEFAULT '{}',position integer NOT NULL DEFAULT 0,deleted_at timestamptz,
 UNIQUE(database_id,id)
);
CREATE UNIQUE INDEX database_one_title ON database_properties(database_id) WHERE type='Title' AND deleted_at IS NULL;
CREATE INDEX database_properties_database ON database_properties(database_id,position);
CREATE TABLE database_views (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),database_id uuid NOT NULL REFERENCES databases(page_id),
 name text NOT NULL,type text NOT NULL CHECK(type IN ('Table','Board','List','Calendar','Gallery','Timeline')),
 config jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,position integer NOT NULL DEFAULT 0
);
ALTER TABLE pages ADD CONSTRAINT pages_parent_id_unique UNIQUE(parent_id,id);
CREATE TABLE database_records (
 page_id uuid PRIMARY KEY REFERENCES pages(id),database_id uuid NOT NULL REFERENCES databases(page_id),
 values jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(values)='object'),version integer NOT NULL DEFAULT 1,
 FOREIGN KEY(database_id,page_id) REFERENCES pages(parent_id,id)
);
CREATE INDEX database_records_database ON database_records(database_id,page_id);
CREATE INDEX database_records_values ON database_records USING gin(values jsonb_path_ops);
CREATE FUNCTION orvyn_database_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 target=coalesce(NEW.database_id,OLD.database_id);
 IF TG_TABLE_NAME='database_properties' THEN UPDATE databases SET schema_version=schema_version+1 WHERE page_id=target; END IF;
 PERFORM pg_notify('orvyn_database_changed',target::text);RETURN NULL;
END $$;
CREATE TRIGGER records_notify AFTER INSERT OR UPDATE OR DELETE ON database_records FOR EACH ROW EXECUTE FUNCTION orvyn_database_notify();
CREATE TRIGGER properties_notify AFTER INSERT OR UPDATE OR DELETE ON database_properties FOR EACH ROW EXECUTE FUNCTION orvyn_database_notify();
CREATE TRIGGER views_notify AFTER INSERT OR UPDATE OR DELETE ON database_views FOR EACH ROW EXECUTE FUNCTION orvyn_database_notify();
CREATE FUNCTION orvyn_record_page_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF NEW.kind='record' THEN
  SELECT database_id INTO target FROM database_records WHERE page_id=NEW.id;
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN UPDATE database_records SET version=version+1 WHERE page_id=NEW.id; END IF;
  IF target IS NOT NULL THEN PERFORM pg_notify('orvyn_database_changed',target::text); END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER record_page_notify AFTER UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION orvyn_record_page_notify();
`,
  },
  {
    version: 10,
    sql: `
CREATE OR REPLACE FUNCTION orvyn_database_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; record_id uuid;
BEGIN
 target=coalesce(NEW.database_id,OLD.database_id);
 IF TG_TABLE_NAME='database_properties' THEN UPDATE databases SET schema_version=schema_version+1 WHERE page_id=target; END IF;
 IF TG_TABLE_NAME='database_records' THEN record_id=coalesce(NEW.page_id,OLD.page_id); END IF;
 PERFORM pg_notify('orvyn_database_changed',json_build_object('databaseId',target,'recordId',record_id)::text);RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION orvyn_record_page_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF NEW.kind='record' THEN
  SELECT database_id INTO target FROM database_records WHERE page_id=NEW.id;
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN UPDATE database_records SET version=version+1 WHERE page_id=NEW.id; END IF;
  IF target IS NOT NULL THEN PERFORM pg_notify('orvyn_database_changed',json_build_object('databaseId',target,'recordId',NEW.id)::text); END IF;
 END IF;
 RETURN NULL;
END $$;
`,
  },
  {
    version: 11,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 2;`,
  },
  {
    version: 12,
    sql: `
CREATE TABLE csv_import_previews (
 token_hash text PRIMARY KEY,database_id uuid NOT NULL REFERENCES databases(page_id),user_id uuid NOT NULL REFERENCES users(id),
 file_digest text NOT NULL,plan jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE INDEX csv_import_expiry ON csv_import_previews(expires_at);
CREATE OR REPLACE FUNCTION orvyn_database_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; record_id uuid;
BEGIN
 target=coalesce(NEW.database_id,OLD.database_id);
 IF TG_TABLE_NAME='database_properties' THEN UPDATE databases SET schema_version=schema_version+1 WHERE page_id=target; END IF;
 IF current_setting('orvyn.bulk_database',true)=target::text THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='database_records' THEN record_id=coalesce(NEW.page_id,OLD.page_id); END IF;
 PERFORM pg_notify('orvyn_database_changed',json_build_object('databaseId',target,'recordId',record_id)::text);RETURN NULL;
END $$;
`,
  },
  {
    version: 13,
    sql: `
CREATE FUNCTION orvyn_record_file_values(record_id uuid,property_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(f.id::text ORDER BY f.id),'[]'::jsonb)
 FROM database_records r
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.values->property_id::text)='array' THEN r.values->property_id::text ELSE '[]'::jsonb END) chosen(id)
 JOIN files f ON f.id::text=chosen.id AND f.page_id=r.page_id AND f.state='ready'
 WHERE r.page_id=record_id;
$$;
CREATE FUNCTION orvyn_record_file_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE record_id uuid;
BEGIN
 record_id=coalesce(NEW.page_id,OLD.page_id);
 IF (TG_OP='INSERT' AND NEW.state='ready') OR (TG_OP='UPDATE' AND (NEW.state='ready' OR OLD.state='ready')) OR (TG_OP='DELETE' AND OLD.state='ready') THEN
  UPDATE database_records SET version=version+1 WHERE page_id=record_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER record_file_notify AFTER INSERT OR UPDATE OR DELETE ON files FOR EACH ROW EXECUTE FUNCTION orvyn_record_file_notify();
`,
  },
  {
    version: 14,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 3;`,
  },
  {
    version: 15,
    sql: `CREATE TABLE page_references(
      source_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      target_id uuid NOT NULL, heading_id text NOT NULL DEFAULT '',
      PRIMARY KEY(source_id,target_id,heading_id));
    CREATE INDEX page_references_target ON page_references(target_id,source_id);
    CREATE FUNCTION orvyn_replace_page_references(source uuid,refs jsonb) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM page_references WHERE source_id=source;
      INSERT INTO page_references(source_id,target_id,heading_id)
      SELECT source,(r->>'pageId')::uuid,coalesce(r->>'headingId','') FROM jsonb_array_elements(refs) r
      ON CONFLICT DO NOTHING;
    END $$;`,
    async after(c: PoolClient) {
      let cursor = "";
      for (;;) {
        const batch = await c.query(
          "SELECT id,document FROM pages WHERE id::text>$1 ORDER BY id LIMIT 100",
          [cursor],
        );
        for (const page of batch.rows)
          await c.query("SELECT orvyn_replace_page_references($1,$2::jsonb)", [
            page.id,
            JSON.stringify(
              documentReferences(
                page.document,
                process.env.ORVYN_ORIGIN || "http://localhost:3000",
              ),
            ),
          ]);
        if (batch.rowCount !== 100) break;
        cursor = batch.rows.at(-1).id;
      }
    },
  },
  {
    version: 16,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 4;`,
  },
  {
    version: 17,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 5;
  CREATE FUNCTION orvyn_editor_assets_allowed(actor uuid,refs jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(refs) AS r("fileId" uuid,image boolean)
      WHERE NOT EXISTS(SELECT 1 FROM files f WHERE f.id=r."fileId" AND f.state='ready'
        AND orvyn_page_role(f.page_id,actor)>=10
        AND (NOT r.image OR f.media_type IN ('image/png','image/jpeg','image/gif','image/webp'))));
  $$;`,
  },
  {
    version: 18,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 6;`,
  },
  {
    version: 19,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 7;`,
  },
  {
    version: 20,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 8;`,
  },
  {
    version: 21,
    sql: `
ALTER TABLE pages ADD COLUMN icon text CHECK(icon IS NULL OR char_length(icon)<=64);
ALTER TABLE pages ADD COLUMN cover_preset text CHECK(cover_preset IN ('aurora','dusk','meadow','ocean','sand','ink'));
ALTER TABLE pages ADD COLUMN cover_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN appearance_version integer NOT NULL DEFAULT 1;
ALTER TABLE pages ADD CONSTRAINT page_one_cover CHECK(cover_preset IS NULL OR cover_file_id IS NULL);
ALTER TABLE spaces ADD COLUMN icon text CHECK(icon IS NULL OR char_length(icon)<=64);
ALTER TABLE spaces ADD COLUMN cover_preset text CHECK(cover_preset IN ('aurora','dusk','meadow','ocean','sand','ink'));
ALTER TABLE spaces ADD COLUMN appearance_version integer NOT NULL DEFAULT 1;
`,
  },
  {
    version: 22,
    sql: `
ALTER TABLE pages DROP CONSTRAINT pages_kind_check;
ALTER TABLE pages ADD CONSTRAINT pages_kind_check CHECK(kind IN ('page','folder','database','record','whiteboard'));
ALTER TABLE pages ADD COLUMN sort_rank double precision NOT NULL DEFAULT 0 CHECK(sort_rank BETWEEN -1e15 AND 1e15);
ALTER TABLE pages ADD COLUMN structure_version integer NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION orvyn_page_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'sort_rank') IS NOT DISTINCT FROM (to_jsonb(OLD)-'sort_rank') THEN RETURN NEW; END IF;
 NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION orvyn_record_page_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF (to_jsonb(NEW)-'sort_rank') IS NOT DISTINCT FROM (to_jsonb(OLD)-'sort_rank') THEN RETURN NULL; END IF;
 IF NEW.kind='record' THEN
  SELECT database_id INTO target FROM database_records WHERE page_id=NEW.id;
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN UPDATE database_records SET version=version+1 WHERE page_id=NEW.id; END IF;
  IF target IS NOT NULL THEN PERFORM pg_notify('orvyn_database_changed',json_build_object('databaseId',target,'recordId',NEW.id)::text); END IF;
 END IF;
 RETURN NULL;
END $$;
WITH ranked AS(SELECT id,row_number() OVER(PARTITION BY space_id,parent_id ORDER BY sort_order,title,id)*1024 AS rank FROM pages) UPDATE pages p SET sort_rank=r.rank FROM ranked r WHERE p.id=r.id;
CREATE INDEX pages_sibling_rank ON pages(space_id,parent_id,sort_rank DESC) WHERE deleted_at IS NULL;
CREATE FUNCTION orvyn_new_page_rank() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous double precision;
BEGIN
 IF NEW.sort_rank<>0 THEN RETURN NEW; END IF;
 IF NEW.parent_id IS NULL THEN
  SELECT sort_rank INTO previous FROM pages WHERE space_id=NEW.space_id AND parent_id IS NULL AND deleted_at IS NULL ORDER BY sort_rank DESC LIMIT 1;
 ELSE
  SELECT sort_rank INTO previous FROM pages WHERE space_id=NEW.space_id AND parent_id=NEW.parent_id AND deleted_at IS NULL ORDER BY sort_rank DESC LIMIT 1;
 END IF;
 NEW.sort_rank=coalesce(previous,0)+1024;
 RETURN NEW;
END $$;
CREATE TRIGGER page_initial_rank BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION orvyn_new_page_rank();
`,
  },
  {
    version: 23,
    sql: `
CREATE TABLE comment_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_at timestamptz,resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,deleted_at timestamptz
);
CREATE INDEX threads_page ON comment_threads(page_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),thread_id uuid NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,body text,request_key uuid NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),edited_at timestamptz,deleted_at timestamptz,
 UNIQUE(author_id,request_key),CHECK(body IS NULL OR length(body) BETWEEN 1 AND 10000),
 CHECK((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL))
);
CREATE INDEX comments_thread ON comments(thread_id,created_at DESC,id DESC);
`,
  },
  {
    version: 24,
    sql: `ALTER TABLE comment_threads ADD COLUMN anchor jsonb CHECK(anchor IS NULL OR (jsonb_typeof(anchor)='object' AND pg_column_size(anchor)<=8192));`,
  },
  {
    version: 25,
    sql: `CREATE TABLE comment_mentions (
 comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(comment_id,user_id)
);
CREATE INDEX comment_mentions_user ON comment_mentions(user_id);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK(kind IN ('comment_mention','thread_reply')),
 comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 thread_id uuid NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),read_at timestamptz,
 UNIQUE(recipient_id,comment_id)
);
CREATE INDEX notifications_recipient ON notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX notifications_unread ON notifications(recipient_id) WHERE read_at IS NULL;`,
  },
  {
    version: 26,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 9;
ALTER TABLE notifications ALTER COLUMN comment_id DROP NOT NULL;
ALTER TABLE notifications ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('comment_mention','thread_reply','document_mention'));
ALTER TABLE notifications ADD CONSTRAINT notifications_source_check CHECK((kind='document_mention' AND comment_id IS NULL AND thread_id IS NULL) OR (kind IN ('comment_mention','thread_reply') AND comment_id IS NOT NULL AND thread_id IS NOT NULL));
CREATE UNIQUE INDEX notifications_document_mention ON notifications(recipient_id,page_id) WHERE kind='document_mention';
CREATE TABLE document_people (
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(page_id,user_id)
);
CREATE INDEX document_people_user ON document_people(user_id);
CREATE FUNCTION orvyn_document_people_allowed(target uuid,ids uuid[]) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(array_length(ids,1),0)<=100 AND NOT EXISTS(SELECT 1 FROM unnest(ids) person WHERE orvyn_page_role(target,person)<10)
$$;
CREATE FUNCTION orvyn_sync_document_people(target uuid,actor uuid,ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF orvyn_page_role(target,actor)<30 OR coalesce(array_length(ids,1),0)>100 THEN RAISE EXCEPTION 'Invalid document people' USING ERRCODE='23514'; END IF;
 DELETE FROM document_people WHERE page_id=target AND NOT(user_id=ANY(ids));
 DELETE FROM notifications WHERE page_id=target AND kind='document_mention' AND NOT(recipient_id=ANY(ids));
 WITH added AS (
  INSERT INTO document_people(page_id,user_id) SELECT target,u.id FROM users u WHERE u.id=ANY(ids) ON CONFLICT DO NOTHING RETURNING user_id
 )
 INSERT INTO notifications(recipient_id,page_id,actor_id,kind)
 SELECT user_id,target,actor,'document_mention' FROM added WHERE user_id<>actor AND orvyn_page_role(target,user_id)>=10
 ON CONFLICT(recipient_id,page_id) WHERE kind='document_mention' DO UPDATE SET actor_id=actor,read_at=NULL,created_at=clock_timestamp();
END $$;`,
  },
  {
    version: 27,
    sql: `CREATE TABLE activity_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 page_id uuid,
 actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 100),
 min_rank smallint NOT NULL DEFAULT 10 CHECK(min_rank IN (10,40,50)),
 bucket timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(space_id,page_id) REFERENCES pages(space_id,id) ON DELETE CASCADE,
 UNIQUE(page_id,actor_id,kind,bucket)
);
CREATE INDEX activity_space ON activity_events(space_id,created_at DESC,id DESC);
CREATE INDEX activity_page ON activity_events(page_id,created_at DESC,id DESC) WHERE page_id IS NOT NULL;
CREATE FUNCTION orvyn_record_activity(target_page uuid,target_space uuid,actor uuid,event text,minimum_rank integer DEFAULT 10,merge_edits boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 scope uuid;
 recorded timestamptz := clock_timestamp();
 window_start timestamptz;
BEGIN
 IF target_page IS NOT NULL THEN
  SELECT space_id INTO scope FROM pages WHERE id=target_page;
  IF scope IS NULL OR (target_space IS NOT NULL AND target_space<>scope) THEN RAISE EXCEPTION 'Invalid activity source' USING ERRCODE='23514'; END IF;
 ELSE scope := target_space;
 END IF;
 IF scope IS NULL THEN RAISE EXCEPTION 'Activity requires a space' USING ERRCODE='23514'; END IF;
 IF merge_edits AND target_page IS NOT NULL THEN window_start := date_bin(interval '5 minutes',recorded,'2000-01-01'::timestamptz); END IF;
 INSERT INTO activity_events(space_id,page_id,actor_id,kind,min_rank,bucket,created_at,updated_at)
 VALUES(scope,target_page,actor,event,minimum_rank,window_start,recorded,recorded)
 ON CONFLICT(page_id,actor_id,kind,bucket) DO UPDATE SET updated_at=excluded.updated_at;
END $$;
`,
  },
  {
    version: 28,
    sql: `CREATE TABLE record_relations (
 property_id uuid NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
 source_id uuid NOT NULL REFERENCES database_records(page_id) ON DELETE CASCADE,
 target_id uuid NOT NULL REFERENCES database_records(page_id) ON DELETE CASCADE,
 PRIMARY KEY(property_id,source_id,target_id)
);
CREATE INDEX record_relations_source ON record_relations(source_id);
CREATE INDEX record_relations_target ON record_relations(target_id);
CREATE FUNCTION orvyn_replace_record_relations(record_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM record_relations WHERE source_id=record_id;
 INSERT INTO record_relations(property_id,source_id,target_id)
 SELECT DISTINCT dp.id,r.page_id,tr.page_id FROM database_records r
 JOIN pages source ON source.id=r.page_id
 JOIN database_properties dp ON dp.database_id=r.database_id AND dp.type='Relation' AND dp.deleted_at IS NULL
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.values->dp.id::text)='array' THEN r.values->dp.id::text ELSE '[]'::jsonb END) ref
 JOIN database_records tr ON tr.page_id::text=ref.value AND tr.database_id::text=dp.config->>'databaseId'
 JOIN pages target ON target.id=tr.page_id AND target.space_id=source.space_id
 WHERE r.page_id=record_id;
END $$;
CREATE FUNCTION orvyn_record_relation_values(record_id uuid,field_id uuid,actor uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(rr.target_id::text ORDER BY rr.target_id),'[]'::jsonb)
 FROM record_relations rr JOIN database_properties dp ON dp.id=rr.property_id AND dp.type='Relation' AND dp.deleted_at IS NULL
 JOIN database_records r ON r.page_id=rr.source_id AND r.database_id=dp.database_id
 JOIN database_records tr ON tr.page_id=rr.target_id AND tr.database_id::text=dp.config->>'databaseId'
 JOIN pages source ON source.id=rr.source_id JOIN pages target ON target.id=rr.target_id AND target.space_id=source.space_id
 WHERE rr.source_id=record_id AND rr.property_id=field_id AND orvyn_page_role(rr.source_id,actor)>=10 AND orvyn_page_role(rr.target_id,actor)>=10
$$;
DO $$ DECLARE item record; BEGIN FOR item IN SELECT DISTINCT r.page_id FROM database_records r JOIN database_properties p ON p.database_id=r.database_id WHERE p.type='Relation' AND p.deleted_at IS NULL LOOP PERFORM orvyn_replace_record_relations(item.page_id); END LOOP; END $$;
`,
  },
  {
    version: 29,
    sql: `CREATE FUNCTION orvyn_formula_number(op text,a double precision,b double precision) RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result double precision;
BEGIN
 IF a IS NULL THEN RETURN NULL; END IF;
 IF op IN ('add','sub','mul','div','mod') AND b IS NULL THEN RETURN NULL; END IF;
 CASE op
 WHEN 'add' THEN result:=a+b;
 WHEN 'sub' THEN result:=a-b;
 WHEN 'mul' THEN result:=a*b;
 WHEN 'div' THEN IF b=0 THEN RETURN NULL; END IF; result:=a/b;
 WHEN 'mod' THEN IF b=0 THEN RETURN NULL; END IF; result:=a-trunc(a/b)*b;
 WHEN 'neg' THEN result:=-a;
 WHEN 'abs' THEN result:=abs(a);
 WHEN 'ceil' THEN result:=ceil(a);
 WHEN 'floor' THEN result:=floor(a);
 WHEN 'round' THEN result:=round(a);
 ELSE RETURN NULL;
 END CASE;
 IF result IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN RETURN NULL; END IF;
 RETURN result;
EXCEPTION WHEN division_by_zero OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN NULL;
END $$;`,
  },
  {
    version: 30,
    sql: `CREATE FUNCTION orvyn_formula_finite(value numeric) RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result double precision;
BEGIN
 result:=value::double precision;
 IF result IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN RETURN NULL; END IF;
 RETURN result;
EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL;
END $$;`,
  },
  { version: 31, sql: templateMigration },
  {
    version: 32,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 10;`,
  },
  {
    version: 33,
    sql: `CREATE TABLE database_deleted_options (
 property_id uuid NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
 option_id uuid NOT NULL,label text NOT NULL,color text NOT NULL,position integer NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(property_id,option_id)
);`,
  },
  { version: 34, sql: searchMigration },
  {
    version: 35,
    sql: `ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 11;`,
  },
  { version: 36, sql: crossSpaceRelationMigration },
  { version: 37, sql: reciprocalRelationMigration },
  { version: 38, sql: multiHopRollupMigration },
  { version: 39, sql: propertySearchMigration },
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
      if ("after" in migration) await migration.after(c);
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
