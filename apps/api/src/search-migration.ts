export const searchMigration = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION orvyn_search_document_text(node jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result text := ''; child jsonb;
BEGIN
 IF jsonb_typeof(node)<>'object' THEN RETURN ''; END IF;
 IF jsonb_typeof(node->'text')='string' THEN result:=node->>'text'; END IF;
 IF node->>'type'='hardBreak' THEN RETURN E'\n'; END IF;
 IF jsonb_typeof(node->'content')='array' THEN
  FOR child IN SELECT value FROM jsonb_array_elements(node->'content') LOOP
   result:=result||orvyn_search_document_text(child);
  END LOOP;
 END IF;
 IF node->>'type' NOT IN ('doc','text') THEN result:=result||E'\n'; END IF;
 RETURN result;
END $$;

CREATE TABLE page_search (
 page_id uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 title_text text NOT NULL,body_text text NOT NULL,
 title_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,title_text)) STORED,
 search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig,title_text),'A') ||
  setweight(to_tsvector('simple'::regconfig,body_text),'B')
 ) STORED
);
CREATE INDEX page_search_words ON page_search USING gin(search_vector);
CREATE INDEX page_search_title_words ON page_search USING gin(title_vector);
CREATE INDEX page_search_titles ON page_search USING gin(title_text gin_trgm_ops);
CREATE INDEX pages_search_recent ON pages(updated_at DESC,id);
CREATE INDEX pages_search_scope ON pages(space_id,kind,updated_at DESC,id);

CREATE FUNCTION orvyn_update_page_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO page_search(page_id,title_text,body_text)
 VALUES(NEW.id,NEW.title,orvyn_search_document_text(NEW.document))
 ON CONFLICT(page_id) DO UPDATE SET title_text=excluded.title_text,body_text=excluded.body_text;
 RETURN NULL;
END $$;
CREATE TRIGGER pages_search_projection AFTER INSERT OR UPDATE OF title,document ON pages
 FOR EACH ROW EXECUTE FUNCTION orvyn_update_page_search();

INSERT INTO page_search(page_id,title_text,body_text)
 SELECT id,title,orvyn_search_document_text(document) FROM pages;

CREATE FUNCTION orvyn_search_query(input text) RETURNS tsquery
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT CASE WHEN count(*)=0 THEN ''::tsquery
 ELSE to_tsquery('simple',string_agg(quote_literal(term)||':*',' & ')) END
 FROM unnest(tsvector_to_array(to_tsvector('simple',input))) AS terms(term)
$$;
`;
