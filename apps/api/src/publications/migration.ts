export const publicationMigration = `
CREATE TABLE publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 root_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 publisher_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 request_digest text NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 token_encrypted text NOT NULL,
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 100),
 scope jsonb NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=12582912),
 version integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT true,
 expires_at timestamptz,
 indexable boolean NOT NULL DEFAULT false,
 password_salt bytea,
 password_hash bytea,
 revoked_at timestamptz,
 revoked_reason text CHECK(revoked_reason IN ('owner','source-access-changed')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((password_salt IS NULL)=(password_hash IS NULL)),
 CHECK(password_salt IS NULL OR (octet_length(password_salt)=16 AND octet_length(password_hash)=64)),
 CHECK(NOT indexable OR password_hash IS NULL),
 UNIQUE(publisher_id,request_id)
);
CREATE INDEX publications_root ON publications(root_id,created_at DESC);
CREATE TABLE publication_requests (
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 root_id uuid NOT NULL,
 publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 digest text NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE publication_sources (
 publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 page_id uuid NOT NULL,
 PRIMARY KEY(publication_id,page_id)
);
CREATE INDEX publication_source_page ON publication_sources(page_id,publication_id);
CREATE TABLE publication_files (
 publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 file_id uuid NOT NULL,
 PRIMARY KEY(publication_id,file_id)
);
CREATE FUNCTION orvyn_revoke_page_publications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='pages' THEN
  target:=coalesce(NEW.id,OLD.id);
  IF TG_OP='UPDATE' AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
    AND NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN RETURN NULL; END IF;
 ELSE target:=coalesce(NEW.page_id,OLD.page_id); END IF;
 UPDATE publications SET revoked_at=now(),revoked_reason='source-access-changed',version=version+1,updated_at=now()
  WHERE revoked_at IS NULL AND id IN (
   WITH RECURSIVE descendants AS (
    SELECT target AS id,0 AS depth UNION ALL SELECT p.id,d.depth+1 FROM pages p JOIN descendants d ON p.parent_id=d.id WHERE d.depth<64
   ) SELECT publication_id FROM publication_sources WHERE page_id IN (SELECT id FROM descendants));
 RETURN NULL;
END $$;
CREATE TRIGGER publication_page_policy_changed AFTER UPDATE OF visibility,parent_id,space_id,deleted_at OR DELETE ON pages
 FOR EACH ROW EXECUTE FUNCTION orvyn_revoke_page_publications();
CREATE TRIGGER publication_grants_changed AFTER INSERT OR UPDATE OR DELETE ON page_permissions
 FOR EACH ROW EXECUTE FUNCTION orvyn_revoke_page_publications();
CREATE FUNCTION orvyn_revoke_member_publications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;target_space uuid;
BEGIN
 IF TG_TABLE_NAME='spaces' THEN
  IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN RETURN NULL; END IF;
  actor:=OLD.owner_id;target_space:=OLD.id;
 ELSE
  IF TG_OP='UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN RETURN NULL; END IF;
  actor:=OLD.user_id;target_space:=OLD.space_id;
 END IF;
 UPDATE publications publication SET revoked_at=now(),revoked_reason='source-access-changed',version=version+1,updated_at=now()
  WHERE publication.publisher_id=actor AND publication.revoked_at IS NULL AND EXISTS(
   SELECT 1 FROM publication_sources source JOIN pages page ON page.id=source.page_id
    WHERE source.publication_id=publication.id AND page.space_id=target_space);
 RETURN NULL;
END $$;
CREATE TRIGGER publication_member_policy_changed AFTER UPDATE OR DELETE ON space_members
 FOR EACH ROW EXECUTE FUNCTION orvyn_revoke_member_publications();
CREATE TRIGGER publication_owner_changed AFTER UPDATE OF owner_id ON spaces
 FOR EACH ROW EXECUTE FUNCTION orvyn_revoke_member_publications();
`;
