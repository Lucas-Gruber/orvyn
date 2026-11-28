export const integrationAccessMigration = `
CREATE TABLE integration_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
 token_hash text UNIQUE NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 scope text NOT NULL DEFAULT 'pages:read' CHECK(scope='pages:read'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE INDEX integration_tokens_owner ON integration_tokens(user_id,created_at DESC);
CREATE TABLE integration_token_pages (
 token_id uuid NOT NULL REFERENCES integration_tokens(id) ON DELETE CASCADE,
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 PRIMARY KEY(token_id,page_id)
);
`;
