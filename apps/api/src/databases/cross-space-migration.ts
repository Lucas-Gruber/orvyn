// References remain structural. Every read still resolves both pages' current
// inherited roles; an edge never grants membership or access to another space.
export const crossSpaceRelationMigration = `
CREATE OR REPLACE FUNCTION orvyn_replace_record_relations(record_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM record_relations WHERE source_id=record_id;
 INSERT INTO record_relations(property_id,source_id,target_id)
 SELECT DISTINCT dp.id,r.page_id,tr.page_id FROM database_records r
 JOIN database_properties dp ON dp.database_id=r.database_id AND dp.type='Relation' AND dp.deleted_at IS NULL
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.values->dp.id::text)='array' THEN r.values->dp.id::text ELSE '[]'::jsonb END) ref
 JOIN database_records tr ON tr.page_id::text=ref.value AND tr.database_id::text=dp.config->>'databaseId'
 WHERE r.page_id=record_id;
END $$;
CREATE OR REPLACE FUNCTION orvyn_record_relation_values(record_id uuid,field_id uuid,actor uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(rr.target_id::text ORDER BY rr.target_id),'[]'::jsonb)
 FROM record_relations rr JOIN database_properties dp ON dp.id=rr.property_id AND dp.type='Relation' AND dp.deleted_at IS NULL
 JOIN database_records r ON r.page_id=rr.source_id AND r.database_id=dp.database_id
 JOIN database_records tr ON tr.page_id=rr.target_id AND tr.database_id::text=dp.config->>'databaseId'
 WHERE rr.source_id=record_id AND rr.property_id=field_id AND orvyn_page_role(rr.source_id,actor)>=10 AND orvyn_page_role(rr.target_id,actor)>=10
$$;
INSERT INTO record_relations(property_id,source_id,target_id)
 SELECT DISTINCT dp.id,r.page_id,tr.page_id FROM database_records r
 JOIN database_properties dp ON dp.database_id=r.database_id AND dp.type='Relation' AND dp.deleted_at IS NULL
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.values->dp.id::text)='array' THEN r.values->dp.id::text ELSE '[]'::jsonb END) ref
 JOIN database_records tr ON tr.page_id::text=ref.value AND tr.database_id::text=dp.config->>'databaseId'
 ON CONFLICT DO NOTHING;
`;
