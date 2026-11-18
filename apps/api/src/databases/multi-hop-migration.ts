export const multiHopRollupMigration = `
CREATE FUNCTION orvyn_rollup_dependency_nodes(database_id uuid,record_ids uuid[],relation_ids uuid[],actor uuid)
RETURNS TABLE(kind text,id uuid,revision text) LANGUAGE sql STABLE SET jit=off AS $$
 WITH paths AS MATERIALIZED (
  SELECT DISTINCT root.id AS first_relation,next.id AS second_relation,leaf.page_id AS leaf_database
  FROM database_properties root
  JOIN database_properties outer_calc ON outer_calc.database_id=root.database_id AND outer_calc.type='Rollup' AND outer_calc.deleted_at IS NULL AND outer_calc.config->'rollup'->>'relationId'=root.id::text
  JOIN database_properties nested ON nested.database_id::text=root.config->>'databaseId' AND nested.id::text=outer_calc.config->'rollup'->>'targetPropertyId' AND nested.type='Rollup' AND nested.deleted_at IS NULL
  JOIN database_properties next ON next.database_id=nested.database_id AND next.id::text=nested.config->'rollup'->>'relationId' AND next.type='Relation' AND next.deleted_at IS NULL
  JOIN databases leaf ON leaf.page_id::text=next.config->>'databaseId'
  WHERE root.database_id=$1 AND root.type='Relation' AND root.deleted_at IS NULL AND ($3 IS NULL OR root.id=ANY($3)) AND orvyn_page_role(leaf.page_id,$4)>=10
 ), middles AS MATERIALIZED (
  SELECT DISTINCT edge.property_id AS first_relation,target_record.page_id AS middle_id
  FROM record_relations edge JOIN database_properties root ON root.id=edge.property_id AND root.database_id=$1 AND root.type='Relation' AND root.deleted_at IS NULL
  JOIN database_records source_record ON source_record.page_id=edge.source_id AND source_record.database_id=$1
  JOIN database_records target_record ON target_record.page_id=edge.target_id AND target_record.database_id::text=root.config->>'databaseId'
  WHERE edge.source_id=ANY($2) AND edge.property_id IN (SELECT first_relation FROM paths)
   AND orvyn_page_role(edge.source_id,$4)>=10 AND orvyn_page_role(edge.target_id,$4)>=10
 ), leaf_candidates AS MATERIALIZED (
  SELECT DISTINCT target_record.page_id,target_record.database_id
  FROM middles mid JOIN paths path ON path.first_relation=mid.first_relation
  JOIN record_relations edge ON edge.source_id=mid.middle_id AND edge.property_id=path.second_relation
  JOIN database_records target_record ON target_record.page_id=edge.target_id AND target_record.database_id=path.leaf_database
 ), readable_leaves AS MATERIALIZED (
  SELECT target.id,candidate.database_id,concat_ws(':',target.version,target.title_version,target.appearance_version,target_record.version,leaf.schema_version) AS revision
  FROM leaf_candidates candidate JOIN pages target ON target.id=candidate.page_id
  JOIN database_records target_record ON target_record.page_id=target.id JOIN databases leaf ON leaf.page_id=candidate.database_id
  WHERE orvyn_page_role(target.id,$4)>=10
 )
 SELECT 'schema'::text,leaf.page_id,leaf.schema_version::text FROM middles mid JOIN paths path ON path.first_relation=mid.first_relation
 JOIN databases leaf ON leaf.page_id=path.leaf_database
 UNION ALL
 SELECT 'record'::text,target.id,target.revision
 FROM middles mid JOIN paths path ON path.first_relation=mid.first_relation
 JOIN record_relations edge ON edge.source_id=mid.middle_id AND edge.property_id=path.second_relation
 JOIN readable_leaves target ON target.id=edge.target_id AND target.database_id=path.leaf_database
$$;
CREATE FUNCTION orvyn_rollup_watch_summary(database_id uuid,record_id uuid,relation_ids uuid[],actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET jit=off AS $$
DECLARE nodes integer; digest text;
BEGIN
 IF relation_ids='{}'::uuid[] THEN RETURN jsonb_build_object('digest',NULL,'weight',0,'poll',false); END IF;
 WITH bounded AS MATERIALIZED (
  SELECT * FROM orvyn_rollup_dependency_nodes(database_id,ARRAY[record_id],relation_ids,actor) LIMIT 10001
 )
 SELECT (SELECT count(*) FROM bounded),
  (SELECT md5(string_agg(item.kind||':'||item.id::text||':'||item.revision,E'\\n' ORDER BY item.kind,item.id,item.revision)) FROM (SELECT DISTINCT * FROM bounded) item)
 INTO nodes,digest;
 IF nodes>10000 THEN RETURN jsonb_build_object('digest',NULL,'weight',10001,'poll',true); END IF;
 IF nodes=0 THEN RETURN jsonb_build_object('digest',NULL,'weight',0,'poll',false); END IF;
 RETURN jsonb_build_object('digest',digest,'weight',nodes,'poll',false);
END $$;
`;
