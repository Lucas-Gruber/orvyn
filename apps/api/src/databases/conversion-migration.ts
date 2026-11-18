export const propertyConversionMigration = `
CREATE TABLE database_property_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id uuid NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,preview_digest text NOT NULL,
 actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 from_type text NOT NULL CHECK(from_type IN ('Text','Number','Date','Checkbox','URL','Email','Phone')),
 to_type text NOT NULL CHECK(to_type IN ('Text','Number','Date','Checkbox','URL','Email','Phone')),
 from_config jsonb NOT NULL,to_config jsonb NOT NULL,
 total_records integer NOT NULL,changed_values integer NOT NULL,cleared_values integer NOT NULL,
 restored_from uuid REFERENCES database_property_changes(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(property_id,request_id)
);
CREATE INDEX database_property_change_history ON database_property_changes(property_id,created_at DESC,id);
CREATE TABLE database_property_change_values (
 change_id uuid NOT NULL REFERENCES database_property_changes(id) ON DELETE CASCADE,
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 original_present boolean NOT NULL,original_value jsonb NOT NULL,
 converted_present boolean NOT NULL,converted_value jsonb NOT NULL,
 PRIMARY KEY(change_id,page_id)
);
`;
