# orvyn.

Your knowledge. Organized.

Orvyn is an early implementation of a self-hosted collaborative workspace. **Not production ready.** The complete product specification is in [docs/PRODUCT.md](docs/PRODUCT.md).

Implemented: Nuxt web client, NestJS API, PostgreSQL persistence, local account lifecycle and SMTP email verification/password reset, session administration, administrator-configured OIDC, hashed cookie sessions, private/team spaces with verified invitations and inherited page permissions, hierarchical pages with trash/history, a shared Tiptap editor with durable Yjs collaboration, live carets, Redis replica coordination and optimistic title updates.

To try it **without Docker Desktop**, open this repository on GitHub, choose **Code → Codespaces → Create codespace on main**, and wait for preparation. In the Codespaces **Ports** tab, open port **5000** in your browser. The repository includes a Node 24/Docker development container and automatic app startup. Keep the forwarded port private. Creating a codespace uses your GitHub Codespaces quota; stop it when finished. Configuration and the app startup path are checked here, but an actual GitHub-hosted codespace has not been created or verified from this environment.

To view it **on your own computer**, install Node >=22.12, pnpm and Docker Desktop, clone this repository, then run `pnpm install --frozen-lockfile` and `pnpm preview:local`. When `ORVYN_LOCAL_PREVIEW_READY` appears, open `http://localhost:5000` on that same computer. This command does not forward a Cloud environment to your computer.

Start with [DEVELOPMENT.md](DEVELOPMENT.md). See [docs/STATUS.md](docs/STATUS.md) for the implementation boundary.

Server CI, production container checks, synchronized app/chart versioning and the tag-triggered image/OCI-chart release workflow: [RELEASE.md](RELEASE.md). Kubernetes deployment, Rancher forms and OIDC SSO: [Helm chart](infrastructure/helm/orvyn/README.md). Native local/S3 attachment drivers: [STORAGE.md](docs/STORAGE.md). Brand and desktop icon assets: [branding](branding/README.md).

Authentication and remaining provider limitations: [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

Permission rules and current limits: [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

Editor, replicas and tested limits: [docs/COLLABORATION.md](docs/COLLABORATION.md).

Private attachments: [docs/FILES.md](docs/FILES.md). Recovery evidence and remaining limits: [docs/BACKUP.md](docs/BACKUP.md).

Structured databases and tested view behavior: [docs/DATABASES.md](docs/DATABASES.md).

Workspace navigation, themes, keyboard behavior and UI verification: [docs/UI.md](docs/UI.md).

Indexed title/document search, space/type filters and current boundaries: [docs/SEARCH.md](docs/SEARCH.md).

Slash commands and links to documents or specific headings: [docs/DOCUMENT_LINKS.md](docs/DOCUMENT_LINKS.md).

Callouts, toggles, tables of contents and syntax-highlighted code: [docs/EDITOR_BLOCKS.md](docs/EDITOR_BLOCKS.md).

Inline images/files and attachment permissions: [docs/EDITOR_MEDIA.md](docs/EDITOR_MEDIA.md). Ordered remaining work: [docs/ROADMAP.md](docs/ROADMAP.md).

Permission-checked document/heading preview cards: [docs/PAGE_PREVIEWS.md](docs/PAGE_PREVIEWS.md).

Opt-in YouTube/Vimeo/Loom players: [docs/VIDEO_EMBEDS.md](docs/VIDEO_EMBEDS.md).

Responsive columns and selection formatting: [docs/EDITOR_LAYOUT.md](docs/EDITOR_LAYOUT.md).

Block selection, drag handles and keyboard movement: [docs/BLOCK_CONTROLS.md](docs/BLOCK_CONTROLS.md).

Page and space icons/covers: [docs/PAGE_APPEARANCE.md](docs/PAGE_APPEARANCE.md).

Folders and sidebar hierarchy movement: [docs/PAGE_HIERARCHY.md](docs/PAGE_HIERARCHY.md).

Page comments and discussion threads: [docs/COMMENTS.md](docs/COMMENTS.md).
