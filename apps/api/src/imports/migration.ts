export const pageImportMigration = `
CREATE TABLE page_import_requests (
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 page_id uuid REFERENCES pages(id) ON DELETE SET NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE INDEX page_import_requests_page ON page_import_requests(page_id);
`;
