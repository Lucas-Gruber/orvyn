# Authentication and account lifecycle

Local accounts use scrypt passwords and random HttpOnly/SameSite=Strict cookie sessions. Password whitespace is significant. Email verification and reset tokens are 256-bit random values, valid for 30 minutes, hashed in PostgreSQL and consumed once. Resetting a password revokes all sessions. User locks serialize login, token issuance and consumption to avoid a password-reset race creating a session with an old password.

Registration currently allows immediate access to an unverified account's private workspace. Verified email is required for administrator bootstrap and OIDC automatic provisioning. Domain/organization invitation restrictions are not implemented yet.

The UI exposes email confirmation, password recovery, active sessions, individual revocation and logout of all sessions. Email links carry tokens in the URL fragment, which the application removes before submitting the token in a JSON body; reverse-proxy URL logs do not contain those tokens.

## Email delivery

`pnpm dev:worker` runs the PostgreSQL-backed mail outbox worker and expired-authentication-state cleanup. Outbox payloads are AES-256-GCM encrypted with ORVYN_ENCRYPTION_KEY; successful delivery clears the payload. SMTP failure retries with bounded exponential delay. Delivery is at least once: a crash between SMTP delivery and database commit can duplicate an email, but its token remains one-use. Local Compose includes Mailpit, with SMTP on 127.0.0.1:1025 and its development mailbox on port 8025. Do not expose the development mailbox publicly.

Production must configure SMTP_URL and MAIL_FROM. Back up ORVYN_ENCRYPTION_KEY separately from encrypted data and supply the same key to all API/worker replicas. Key rotation tooling is still outstanding.

## OIDC

OIDC uses openid-client 6.9.0, Authorization Code with PKCE S256, random state and nonce, a ten-minute browser-bound flow stored in PostgreSQL, and signed ID-token verification through the provider's JWKS. The temporary correlation cookie uses SameSite=Lax for cross-site redirects; the resulting session cookie uses SameSite=Strict. HTTPS is required. HTTP loopback issuers are permitted only when explicitly enabled outside production, and are used by the isolated protocol test fixture. Redirects from metadata/token fetches are not followed automatically.

Administrators configure provider display name, issuer, client ID, encrypted client secret, scopes, enablement and automatic provisioning in the SSO administration screen. Provider issuer and client ID are immutable; create another provider to change identity. Responses disclose only whether a secret is configured. An empty secret field preserves it; the API supports explicit null to remove a secret. Disabling a provider revokes sessions issued through it. Configuration revisions invalidate in-flight authentication.

External identities are keyed by provider ID and subject. An existing local account is **never** silently linked using a matching email. Automatic provisioning requires a provider-verified email that is not already registered. Explicit linking and administrator identity assignment are outstanding. Group mappings, provider logout/back-channel logout, SAML and desktop authentication are also outstanding.

## Administrator bootstrap

1. Register and verify the administrator's account.
2. From the repository root, run `pnpm admin:grant user@example.org` with access to the local application's database configuration.
3. Reload the application to see SSO administration.

There is no default administrator password or first-user privilege escalation. CLI grants are audited. Broader user management and delegated administration remain outstanding.

## Validation

`pnpm test` builds the application, creates a uniquely named temporary PostgreSQL database, starts isolated API, worker and Nuxt processes, and removes these processes/database afterward. It uses the local Mailpit service. Tests cover SMTP verification/reset, token replay, password whitespace, session isolation/revocation, migrations/upgrades/rollback, and a local OIDC protocol fixture signing real RSA ID tokens. The OIDC fixture checks PKCE and tests invalid signatures, browser binding, replay, account collision, unverified email and provider revocation. This does not establish compatibility with a real Keycloak, Authentik or Entra deployment.

A real Chromium test exercises registration, page persistence after reload, email verification, session settings and provider configuration through the UI. It uses CHROMIUM_PATH, default /usr/bin/chromium. Windows/macOS and desktop packaging have not been tested.

Outbound SMTP batches reuse a bounded connection pool (at most two connections, 100 messages per connection). Connection/greeting waits are limited to 5 seconds and idle socket waits to 10 seconds; failures keep the encrypted outbox entry and retry with the existing backoff. Authentication and storage expiry maintenance run independently of mail delivery. Test mailbox polling searches by recipient instead of assuming all messages fit on the first inbox page.
