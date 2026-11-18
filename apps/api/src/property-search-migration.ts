export const propertySearchMigration = `
ALTER TABLE page_search ADD COLUMN property_text text NOT NULL DEFAULT '';
DROP INDEX page_search_words;
ALTER TABLE page_search DROP COLUMN search_vector;
ALTER TABLE page_search ADD COLUMN content_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,body_text)) STORED;
ALTER TABLE page_search ADD COLUMN property_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,translate(property_text,'<>','  '))) STORED;
ALTER TABLE page_search ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
 setweight(to_tsvector('simple'::regconfig,title_text),'A') ||
 setweight(to_tsvector('simple'::regconfig,body_text),'B') ||
 setweight(to_tsvector('simple'::regconfig,translate(property_text,'<>','  ')),'C')
) STORED;
CREATE INDEX page_search_words ON page_search USING gin(search_vector);
CREATE INDEX page_search_content_words ON page_search USING gin(content_vector);
CREATE INDEX page_search_property_words ON page_search USING gin(property_vector);

CREATE FUNCTION orvyn_record_search_text(record_values jsonb,properties jsonb,metadata jsonb DEFAULT '{}') RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result text := ''; field jsonb; value jsonb; rendered text;
BEGIN
 FOR field IN SELECT item FROM jsonb_array_elements(properties) AS fields(item) LOOP
  value:=record_values->(field->>'id'); rendered:=NULL;
  CASE field->>'type'
   WHEN 'Text','URL','Email','Phone','Date' THEN
    IF jsonb_typeof(value)='string' THEN rendered:=value#>>'{}'; END IF;
   WHEN 'Number' THEN
    IF jsonb_typeof(value)='number' THEN rendered:=value#>>'{}'; END IF;
   WHEN 'Checkbox' THEN
    IF jsonb_typeof(value)='boolean' THEN rendered:=value#>>'{}'; END IF;
   WHEN 'Select','Status' THEN
    SELECT option->>'label' INTO rendered FROM jsonb_array_elements(coalesce(field->'config'->'options','[]'::jsonb)) AS options(option) WHERE option->>'id'=value#>>'{}' LIMIT 1;
   WHEN 'MultiSelect' THEN
    IF jsonb_typeof(value)='array' THEN
     SELECT string_agg(option->>'label',', ' ORDER BY ord) INTO rendered
     FROM jsonb_array_elements(coalesce(field->'config'->'options','[]'::jsonb)) WITH ORDINALITY AS options(option,ord)
     WHERE value ? (option->>'id');
    END IF;
   WHEN 'CreatedTime' THEN rendered:=metadata->>'created';
   WHEN 'LastEditedTime' THEN rendered:=metadata->>'edited';
   ELSE NULL;
  END CASE;
  IF rendered IS NOT NULL AND btrim(rendered)<>'' THEN
   result:=result||translate(field->>'name',chr(10)||chr(13)||chr(9),'   ')||': '||translate(rendered,chr(10)||chr(13)||chr(9),'   ')||E'\n';
  END IF;
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION orvyn_refresh_record_search(target_database uuid,target_record uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE properties jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'type',type,'config',config) ORDER BY position,id),'[]'::jsonb)
 INTO properties FROM database_properties WHERE database_id=target_database AND deleted_at IS NULL;
 WITH content AS MATERIALIZED (
  SELECT record.page_id,orvyn_record_search_text(record.values,properties,
   jsonb_build_object('created',to_char(page.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'edited',to_char(page.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) AS text
  FROM database_records record JOIN pages page ON page.id=record.page_id
  WHERE record.database_id=target_database AND (target_record IS NULL OR record.page_id=target_record)
 )
 UPDATE page_search projection SET property_text=content.text FROM content
 WHERE projection.page_id=content.page_id AND projection.property_text IS DISTINCT FROM content.text;
END $$;
CREATE FUNCTION orvyn_record_search_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN UPDATE page_search SET property_text='' WHERE page_id=OLD.page_id;
 ELSE PERFORM orvyn_refresh_record_search(NEW.database_id,NEW.page_id); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER database_records_search_projection AFTER INSERT OR UPDATE OF values,database_id OR DELETE ON database_records
 FOR EACH ROW EXECUTE FUNCTION orvyn_record_search_changed();
CREATE FUNCTION orvyn_property_search_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM orvyn_refresh_record_search(coalesce(NEW.database_id,OLD.database_id)); RETURN NULL;
END $$;
CREATE TRIGGER database_properties_search_projection AFTER INSERT OR UPDATE OF name,type,config,deleted_at OR DELETE ON database_properties
 FOR EACH ROW EXECUTE FUNCTION orvyn_property_search_changed();
CREATE FUNCTION orvyn_record_search_metadata_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 SELECT database_id INTO target FROM database_records WHERE page_id=NEW.id;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM database_properties WHERE database_id=target AND deleted_at IS NULL AND type IN ('CreatedTime','LastEditedTime')) THEN
  PERFORM orvyn_refresh_record_search(target,NEW.id);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER pages_search_record_metadata AFTER UPDATE ON pages FOR EACH ROW
 WHEN (NEW.kind='record' AND (OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.updated_at IS DISTINCT FROM NEW.updated_at))
 EXECUTE FUNCTION orvyn_record_search_metadata_changed();
DO $$ DECLARE target uuid; BEGIN
 FOR target IN SELECT page_id FROM databases LOOP PERFORM orvyn_refresh_record_search(target); END LOOP;
END $$;
`;
