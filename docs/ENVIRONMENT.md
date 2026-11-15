# Environment variables
DATABASE_URL: required PostgreSQL connection URL; secret.
ORVYN_DB_PASSWORD: local Compose database password; secret; must match DATABASE_URL.
ORVYN_ORIGIN: exact permitted browser origin, default http://localhost:3000.
ORVYN_API_URL: Nuxt build-time proxy target, default http://127.0.0.1:3001.
NODE_ENV: production enables Secure cookies; HTTPS required.
TEST_URL: integration test base URL, default http://127.0.0.1:3000.
