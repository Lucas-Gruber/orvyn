export const whiteboardMigration = `
CREATE TABLE whiteboard_documents (
 page_id uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 version integer NOT NULL DEFAULT 1,
 scene jsonb NOT NULL DEFAULT '{"elements":[],"backgroundColor":"#ffffff","gridSize":null}',
 state bytea CHECK(octet_length(state)<=2097152),
 search_text text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whiteboard_revisions (
 page_id uuid NOT NULL REFERENCES whiteboard_documents(page_id) ON DELETE CASCADE,
 version integer NOT NULL,scene jsonb NOT NULL,author_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(page_id,version)
);
INSERT INTO whiteboard_documents(page_id) SELECT id FROM pages WHERE kind='whiteboard';
CREATE OR REPLACE FUNCTION orvyn_update_page_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO page_search(page_id,title_text,body_text)
 VALUES(NEW.id,NEW.title,CASE WHEN NEW.kind='whiteboard' THEN coalesce((SELECT search_text FROM whiteboard_documents WHERE page_id=NEW.id),'') ELSE orvyn_search_document_text(NEW.document) END)
 ON CONFLICT(page_id) DO UPDATE SET title_text=excluded.title_text,body_text=excluded.body_text;
 RETURN NULL;
END $$;
CREATE FUNCTION orvyn_whiteboard_search_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE page_search SET body_text=NEW.search_text WHERE page_id=NEW.page_id AND body_text IS DISTINCT FROM NEW.search_text;
 RETURN NULL;
END $$;
CREATE TRIGGER whiteboard_search_projection AFTER INSERT OR UPDATE OF search_text ON whiteboard_documents
 FOR EACH ROW EXECUTE FUNCTION orvyn_whiteboard_search_changed();
ALTER TABLE pages ALTER COLUMN document_schema_version SET DEFAULT 13;
`;
