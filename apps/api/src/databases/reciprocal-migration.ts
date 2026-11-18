export const reciprocalRelationMigration = `
CREATE TABLE database_relation_pairs (
 left_property_id uuid PRIMARY KEY REFERENCES database_properties(id) ON DELETE CASCADE,
 right_property_id uuid NOT NULL UNIQUE REFERENCES database_properties(id) ON DELETE CASCADE,
 CHECK(left_property_id<right_property_id)
);
CREATE FUNCTION orvyn_disconnect_relation_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE database_properties SET config=config-'reciprocalPropertyId'
 WHERE id IN (OLD.left_property_id,OLD.right_property_id) AND config ? 'reciprocalPropertyId';
 RETURN NULL;
END $$;
CREATE TRIGGER disconnect_relation_pair AFTER DELETE ON database_relation_pairs
 FOR EACH ROW EXECUTE FUNCTION orvyn_disconnect_relation_pair();
`;
