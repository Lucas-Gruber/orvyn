# Releases

Server CI and release automation are configured. The current release source is **0.3.2**; see [the changelog](CHANGELOG.md) for sidebar resizing and one-click rendering of existing Mermaid code blocks. The `v0.3.2` tag publishes matching server images and the Helm chart only after its release workflow succeeds. A source version or pushed tag alone does not establish artifact availability; check the [completed release](https://github.com/Lucas-Gruber/orvyn/releases/tag/v0.3.2) before deployment. Version numbers are not a production-readiness claim. Do not create tags or publish releases without explicit authorization. The version command never commits, tags, pushes or publishes anything.

## Checks on pushes and pull requests

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, manual dispatch and calls from the release workflow. It installs the pinned PNPM version on Node 24, verifies manifest versions, builds the application, checks TypeScript/Vue types and runs the release-policy and complete application integration tests. PostgreSQL, Redis, SeaweedFS and Mailpit are disposable local services on the GitHub runner. Chromium exercises real browser flows. Only test output, redacted infrastructure startup diagnostics and explicitly selected screenshots are retained as artifacts; environment files and storage credentials are excluded.

The same workflow builds production images for **web**, **api**, **collaboration** and **worker**, then runs them together over a local HTTPS proxy. The test checks non-root execution, secure cookies, anonymous access rejection, attachment integrity, durable collaboration through the public WebSocket route and actual worker email delivery to local Mailpit. Its database, bucket, containers and TLS key are private disposable test resources. Existing developer infrastructure/data is preserved by the image-test command.

All referenced JavaScript actions are pinned to checked commit SHAs and use Node 24; the pinned Cosign installer is a composite action. Fork PR jobs have read-only repository permissions and no publishing token. Production image builds use a digest-pinned Node 24 base, a frozen dependency lockfile, current PNPM deployment and compiled runtime files. Runtime users are non-root. Local tests additionally run with read-only filesystems, dropped capabilities and no privilege escalation.

## Prepare a version

```sh
pnpm release:version patch --dry-run
pnpm release:version patch
# Also supported: minor, major, or an explicit version such as 0.2.0-rc.1.
pnpm release:check
```

The command synchronizes the root and owned `@orvyn/*` package manifests and both Helm `version` and `appVersion`, preserves dependency versions, supports SemVer prereleases/build metadata, and rolls back completed file writes if a later write fails. An explicit version can repair manifest drift. Review the diff, commit and push it using the normal development process. Neither this command nor the checks create Git tags. Every manifest must exactly match the tag before a release can run.

There is no desktop application yet. Checks deliberately reject a newly added desktop directory until its Tauri/Cargo version synchronization is implemented. Desktop installers, platform signing, updater feeds and Flatpak publication are not simulated by this server pipeline.

## Tag-triggered server publication

Only a pushed `v<SemVer>` tag starts `.github/workflows/release.yml`. The tag must match all manifests, and its commit must belong to `main`. The release reruns the complete CI checks before building/pushing candidates. The actual remote tag is checked again before publishing; both lightweight and annotated tags resolve to the validated commit.

Eight candidate builds run on native `ubuntu-24.04` (AMD64) and `ubuntu-24.04-arm` runners, with SBOM and provenance attestations and separate caches. Their exact platform-index digests are passed as immutable artifacts. The publisher checks all eight records against this repository/version/commit and the registry bytes, verifies each architecture and its attached attestation, then combines each pair into one component index. It verifies that the combined index retains every platform and attestation descriptor. Only then does it reserve a draft release, sign/verify image digests and the checksum manifest using GitHub OIDC/Cosign, and promote version aliases. Registry digests are calculated from exact raw manifest bytes; no human-readable Buildx formatter is used.

For this repository the image names are:

- `ghcr.io/lucas-gruber/orvyn-web:<version>`
- `ghcr.io/lucas-gruber/orvyn-api:<version>`
- `ghcr.io/lucas-gruber/orvyn-collaboration:<version>`
- `ghcr.io/lucas-gruber/orvyn-worker:<version>`

Names are derived from `GITHUB_REPOSITORY`, so forks use their own namespace. SemVer build metadata maps `+` to `_` in Docker tags. Prereleases never move `latest`. Older stable releases cannot move either the image or GitHub latest channel backwards. Publishing is serialized across tags. GitHub retains only one pending concurrency run; if several tags are pushed while a release runs, explicitly rerun any superseded pending tag that is still needed.

The finished GitHub release contains generated release notes and:

- `orvyn-<version>-server-images.json`: component references pinned by exact digest, source commit and supported architectures.
- `SHA256SUMS`: the SHA-256 checksum of that manifest.
- `SHA256SUMS.sigstore.json`: its verifiable keyless signature bundle.

Use the manifest's digest references for a complete deployment. A registry cannot update four independent package tags atomically; a failed promotion keeps the GitHub release in draft. Version aliases are checked against the expected digest. Existing different image content, existing published releases and unrelated drafts are rejected. Existing release assets are compared and never silently replaced. No server deployment, database upgrade or desktop update is triggered by publishing images.

## Access, retries and verification

GitHub Actions must be enabled. The release jobs use the repository `GITHUB_TOKEN` with only their required permissions: package writing for builds; contents/package writing and OIDC token issuance for publication. No personal access token or stored signing private key is required by this workflow. Organization/package policies must permit those operations. Package visibility/access remains under the repository owner's control; check it after the first authorized publication if others should be able to pull the images.

Test results and platform-record artifacts have distinct attempt names, so failed-job retries do not collide with earlier uploads. The publisher chooses the newest successfully uploaded record for each component/architecture pair, then validates its source/version/digest. An interrupted publication retains its matching draft and completed assets. **Rerun failed jobs** while the original platform-record artifacts are retained (seven days); the publisher reproducibly combines those exact digests and resumes the resulting component indexes and verifies/reuses its checksum bundle and assets. Rebuilding all candidates can produce different provenance digests and is not a request to replace an existing version. Use a new version when the immutable content no longer matches. Candidate tags are retained; no automatic package deletion is configured.

Verify downloaded assets with `sha256sum -c SHA256SUMS`, then:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity 'https://github.com/Lucas-Gruber/orvyn/.github/workflows/release.yml@refs/tags/v<VERSION>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
```

Use `cosign verify` with the same identity/issuer options and the image's `@sha256:...` reference to verify an image signature. The same command verifies the OCI chart manifest signature. Substitute the actual tag version; forks must use their own repository identity.

## Local image checks

The local image check expects a Linux/WSL shell with the local Docker socket at `/var/run/docker.sock`; CI uses Ubuntu. After installing dependencies, preparing local infrastructure and building the workspace, build all four Dockerfile targets with the current version:

```sh
for component in web api collaboration worker; do
  docker buildx build --load --target "$component" \
    --build-arg "VERSION=$(node -p 'require("./package.json").version')" \
    --build-arg "REVISION=$(git rev-parse HEAD)" \
    --tag "orvyn/$component:ci" --file infrastructure/docker/Dockerfile .
done
pnpm test:images
pnpm test:release
```

Builds without an explicit `VERSION` argument carry the `development` label; CI and releases always supply the checked manifest version.

For a corporate/session HTTPS proxy CA, add `--secret id=build_ca,src=/path/to/ca.pem` to the build. It is mounted only in dependency-install steps and is not copied into image layers. TLS verification stays enabled. Runtime credentials are supplied separately; development `.env` files and signing-key formats are excluded from the build context.

Local validation covers the actual four Linux/amd64 images, application/browser integration, native-platform metadata validation/merging, release policy and retry orchestration, and workflow syntax with Actionlint. Actual Buildx raw-manifest hashing and dry-run descriptor preservation are also checked against registry images. The authorized v0.1.1 server release completed successfully on native AMD64/ARM64 runners, including its OIDC/Cosign signing and publication job. The v0.2.0 release also completed successfully. Version v0.3.0 has its own tag-triggered validation and publication run.

The initial `v0.1.0` tag contains a Buildx scalar-formatting assumption that cannot complete publication. `v0.1.1` corrects that verification and replaces emulated builds with native runners. Existing source tags are preserved.

## Helm checks and publication

The regular checks run pinned Helm 3.22.1 lint/template/schema validation, strict Kubeconform validation for 27 installation modes, negative values tests and consistency checks for all Rancher questions. The default chart requires explicit SMTP configuration. Application tests cover the S3 default and native filesystem drivers, plus actual database snapshot/restore scripts and failure cases. A separate Keycloak invocation verifies SSO provisioning with local signup disabled. A checksum-verified Kind test installs internal services with wait/atomic, exercises private attachments, creates a CronJob-derived backup and isolated restore Job on the retained PVC, upgrades to two API replicas, closes registration, checks OIDC configuration and unchanged secrets, rolls back configuration, and separately verifies shared local PVC behavior. Real Kind execution requires a Docker host with cgroup delegation; the managed Cloud host does not provide it. The workflow uses a normal Ubuntu runner.

Checks package the chart with normalized tar/gzip metadata. Repackaging an unchanged commit produces identical bytes, which protects draft/asset retry guards. The chart artifact has an independent attempt name and metadata binding it to the validated source/version/digest. The publisher validates it separately from the eight architecture records; retries select the newest available chart package from the same source.

After all four immutable versioned image tags have been verified, the publisher pushes `oci://ghcr.io/lucas-gruber/charts/orvyn:<version>` (forks use their own owner), verifies its Helm config/layer media types and package digest, and signs/verifies its exact OCI manifest using the existing GitHub workflow identity. Chart versions are immutable; an existing version is reused only if the checked package matches. There is no `latest` chart alias. The GitHub release remains a draft until images, chart and signatures are complete. The attached chart package is included in signed `SHA256SUMS`, and the server manifest records its repository/version/package hash. No cluster deployment is performed by publication.

Chart usage, Rancher, GitOps, HTTPS, Secret rotation and database/storage migration limits are documented in [the chart README](infrastructure/helm/orvyn/README.md).
