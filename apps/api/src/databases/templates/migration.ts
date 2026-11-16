export const templateMigration = `CREATE TABLE database_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 database_id uuid NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
 source_page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('database','record')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 payload jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX database_templates_space ON database_templates(space_id,kind,created_at DESC,id DESC);
CREATE INDEX database_templates_database ON database_templates(database_id,kind,created_at DESC,id DESC);
CREATE TABLE template_applications (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 template_id uuid REFERENCES database_templates(id) ON DELETE SET NULL,
 request_hash text NOT NULL,
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,request_id)
);
CREATE FUNCTION orvyn_template_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item database_templates;
BEGIN
 IF TG_OP='DELETE' THEN item:=OLD; ELSE item:=NEW; END IF;
 PERFORM pg_notify('orvyn_database_changed',json_build_object('databaseId',item.database_id,'recordId',CASE WHEN item.kind='record' THEN item.source_page_id ELSE NULL END)::text);
 RETURN NULL;
END $$;
CREATE TRIGGER templates_notify AFTER INSERT OR UPDATE OR DELETE ON database_templates FOR EACH ROW EXECUTE FUNCTION orvyn_template_notify();`;
