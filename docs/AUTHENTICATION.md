# Authentication and account lifecycle

Local accounts use scrypt passwords and random HttpOnly/SameSite=Strict cookie sessions. Password whitespace is significant. Email verification and reset tokens are 256-bit random values, valid for 30 minutes, hashed in PostgreSQL and consumed once. Resetting a password revokes all sessions. User locks serialize login, token issuance and consumption to avoid a password-reset race creating a session with an old password.

Local self-registration is configurable. By default, new local accounts can immediately use their unverified private workspace. Verified email is required for administrator bootstrap and OIDC automatic provisioning. Organization-specific invitation policies remain outstanding.

## Local registration policy

The 0.3.0 development source adds two deployment settings:

| Environment variable                       | Default | Behavior                                                                                                                                              |
| ------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORVYN_REGISTRATION_ENABLED`               | `true`  | Exact `true` or `false`. Disabling rejects local `POST /auth/register` with 403 before password hashing, account creation, email or session issuance. |
| `ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS` | empty   | Optional comma-separated list of at most 20 exact DNS domains for new local accounts. Empty permits any otherwise valid email.                        |

Domains are case-insensitive and canonicalized through IDNA. A configured `company.example` permits `person@company.example`, but not `person@sub.company.example` or `person@company.example.evil.test`. Wildcards, URLs, malformed labels and empty entries are rejected. Unicode domains are supported in environment configuration; Helm/Rancher values use their ASCII/Punycode spelling. Invalid settings stop API startup with a value-free configuration error. Apply the same policy to all API replicas and wait for the configuration rollout to complete.

Existing local accounts can still sign in and recover their passwords regardless of their email domain. Existing sessions are not revoked. **OIDC automatic provisioning remains a separate provider setting**; verified identities can be provisioned even when local self-registration is disabled. This does not add invitation-only signup, restrict team invitations or implement OIDC group mappings.

Before disabling local account creation, establish and test an administrator account or a deployment-managed OIDC provider with the intended provisioning/bootstrap settings. Disabling signup on an empty instance with no usable identity provider does not create a recovery administrator automatically.

`GET /api/v1/auth/options` is intentionally public and uncached. It returns only `{registration: {enabled, allowedEmailDomains}}`, so the login screen can show the rule before signup. The domain list is therefore public configuration. If loading it fails, the UI hides account creation, keeps existing sign-in available and offers a retry; the API remains authoritative. A domain restriction is checked again on direct registration requests. Authentication tokens, passwords, issuer secrets and internal endpoints are never included in that response.

Helm values are `auth.registration.enabled` and `auth.registration.allowedEmailDomains`; Rancher places them under **Authentication**. Only API pods receive these variables, and policy changes update their rollout checksum. The published 0.2.0 images/chart do not include these controls; use matching development-source builds until a new release is published.

The UI exposes email confirmation, password recovery, active sessions, individual revocation and logout of all sessions. Email links carry tokens in the URL fragment, which the application removes before submitting the token in a JSON body; reverse-proxy URL logs do not contain those tokens.

## Email delivery

`pnpm dev:worker` runs the PostgreSQL-backed mail outbox worker and expired-authentication-state cleanup. Outbox payloads are AES-256-GCM encrypted with ORVYN_ENCRYPTION_KEY; successful delivery clears the payload. SMTP failure retries with bounded exponential delay. Delivery is at least once: a crash between SMTP delivery and database commit can duplicate an email, but its token remains one-use. Local Compose includes Mailpit, with SMTP on 127.0.0.1:1025 and its development mailbox on port 8025. Do not expose the development mailbox publicly.

Production must configure SMTP_URL and MAIL_FROM. Back up ORVYN_ENCRYPTION_KEY separately from encrypted data and supply the same key to all API/worker replicas. Key rotation tooling is still outstanding.

## OIDC

OIDC uses openid-client 6.9.0, Authorization Code with PKCE S256, random state and nonce, a ten-minute browser-bound flow stored in PostgreSQL, and signed ID-token verification through the provider's JWKS. The temporary correlation cookie uses SameSite=Lax for cross-site redirects; the resulting session cookie uses SameSite=Strict. HTTPS is required. HTTP loopback issuers are permitted only when explicitly enabled outside production, and are used by the isolated protocol test fixture. Redirects from metadata/token fetches are not followed automatically.

Administrators configure provider display name, issuer, client ID, encrypted client secret, token-endpoint authentication method, scopes, enablement and automatic provisioning in the SSO administration screen. Provider issuer and client ID are immutable; create another provider to change identity. Responses disclose only whether a secret is configured. An empty secret field preserves it; the API supports explicit null to remove a secret. Disabling a provider revokes sessions issued through it. Configuration revisions invalidate in-flight authentication.

External identities are keyed by provider ID and subject. An existing local account is **never** silently linked using a matching email. Automatic provisioning requires a provider-verified email that is not already registered. Explicit linking and administrator identity assignment are outstanding. Group mappings, provider logout/back-channel logout, SAML and desktop authentication are also outstanding.

## Deployment-managed OIDC

OIDC can also be configured declaratively. The stable redirect URI is **`<ORVYN_ORIGIN>/api/v1/oidc/deployment/callback`**. Register that exact URL at the provider before enabling sign-in. The normal administration screen still manages other providers.

| Variable                        | Meaning                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORVYN_OIDC_ENABLED`            | `true` enables the deployment-managed provider; absent/`false` disables only deployment-managed providers.                                                            |
| `ORVYN_OIDC_NAME`               | Sign-in button label; defaults to `Single sign-on`.                                                                                                                   |
| `ORVYN_OIDC_ISSUER`             | HTTPS issuer, including a realm/tenant path when applicable.                                                                                                          |
| `ORVYN_OIDC_CLIENT_ID`          | Registered client ID.                                                                                                                                                 |
| `ORVYN_OIDC_CLIENT_SECRET`      | Client secret, supplied from a secret store. It is encrypted before persistence.                                                                                      |
| `ORVYN_OIDC_CLIENT_AUTH_METHOD` | `client_secret_post`, `client_secret_basic` or `none` for a public PKCE client. Without an explicit method, a configured secret selects POST; otherwise `none`.       |
| `ORVYN_OIDC_SCOPES`             | Space-separated scopes including `openid`; defaults to `openid email profile`.                                                                                        |
| `ORVYN_OIDC_AUTO_PROVISION`     | `true` allows new accounts with a provider-verified email; defaults to `false`.                                                                                       |
| `ORVYN_OIDC_ADMIN_SUBJECT`      | Optional exact, immutable provider `sub` for instance administration. This is an identity ID, not an email address or display name.                                   |
| `ORVYN_OIDC_BOOTSTRAP_MODE`     | `auto` applies settings at API startup; `external` leaves them to a configuration command/Job; `wait` waits up to two minutes for that command's exact configuration. |

For a single API, `auto` is the default. For Kubernetes or multiple API replicas, use `external` and apply configuration once through the same API image:

```sh
node dist/commands/configure.js
```

The command waits for PostgreSQL, applies advisory-lock-protected migrations and transactionally configures OIDC. Supply the database, encryption and OIDC environment to that command. API replicas in `external` mode do not receive the client secret through their environment and never overwrite configuration during restarts. A post-install/upgrade configuration Job can therefore run after application readiness, without an application/Job dependency cycle. Runtime discovery reads the encrypted provider settings from PostgreSQL.

Reapplying identical settings does not rotate encrypted credentials or configuration revisions. Changed settings invalidate in-flight sign-ins. Disabling/replacing the deployment provider revokes its sessions. The administration UI marks it as deployment-managed and rejects edits through the HTTP API. Existing manual providers retain their own controls.

The optional administrator subject grants an effective role through its verified external identity. Changing/removing that subject removes the deployment grant on subsequent requests; independent CLI-granted administrator roles remain intact. There is no first-user administrator grant and no email-based identity linking.

Keep issuer and client identity stable. A different issuer creates a different provider identity; changing an existing issuer's client ID or claiming an already manually configured issuer fails rather than reusing someone else's identity mapping. Existing email collisions still require an explicit identity migration. Removing deployment variables disables the managed provider in `auto` mode; apply the configuration command when using `external` mode.

## Administrator bootstrap

1. Register and verify the administrator's account.
2. From the repository root, run `pnpm admin:grant user@example.org` with access to the local application's database configuration.
3. Reload the application to see SSO administration.

There is no default administrator password or first-user privilege escalation. CLI grants are audited. Broader user management and delegated administration remain outstanding.

## Validation

`pnpm test` builds the application, creates a uniquely named temporary PostgreSQL database, starts isolated API, worker and Nuxt processes, and removes these processes/database afterward. It uses the local Mailpit service. Tests cover SMTP verification/reset, token replay, password whitespace, session isolation/revocation, migrations/upgrades/rollback, and a local OIDC protocol fixture signing real RSA ID tokens. The OIDC fixture checks PKCE and tests invalid signatures, browser binding, replay, account collision, unverified email and provider revocation. A separate browser test runs an actual pinned Keycloak 26.4 container and verifies the deployment callback, HTTP Basic client authentication, PKCE, verified-email provisioning, exact-subject administrator bootstrap and the read-only administration screen. The Keycloak fixture uses explicitly permitted loopback HTTP outside production. Production issuers require HTTPS. Authentik and Entra compatibility has not been established by these tests.

A real Chromium test exercises registration, page persistence after reload, email verification, session settings and provider configuration through the UI. It uses CHROMIUM_PATH, default /usr/bin/chromium. Windows/macOS and desktop packaging have not been tested.

Outbound SMTP batches reuse a bounded connection pool (at most two connections, 100 messages per connection). Connection/greeting waits are limited to 5 seconds and idle socket waits to 10 seconds; failures keep the encrypted outbox entry and retry with the existing backoff. Authentication and storage expiry maintenance run independently of mail delivery. Test mailbox polling searches by recipient instead of assuming all messages fit on the first inbox page.
