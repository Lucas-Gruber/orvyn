# Private files and object storage

Attachments are uploaded to an S3-compatible object store with random server-generated keys. The API records page ownership, media type detected from bytes, size, uploader and lifecycle state. It never returns a public bucket URL. Every list, download and preview checks the page's inherited permissions; trashing a parent also hides attachments below it. Revoking membership blocks subsequent attachment requests.

Uploads require an authenticated editor, the configured Origin and multipart/form-data. Authentication/authorization runs before multipart buffering. MAX_UPLOAD_BYTES defaults to 10 MiB and may be configured from 1 byte to 100 MiB. The API exposes the limit to the UI. Each account is also subject to an upload request limit. Uploaded filenames are normalized and escaped for download headers, and are never used as filesystem or object keys.

Opaque files download as application/octet-stream with Content-Disposition: attachment and nosniff. PNG/JPEG/GIF/WebP signatures permit authenticated image previews; SVG/HTML are never rendered inline. Advanced image validation/optimization, malware scanning and office/PDF rendering remain outstanding. Client-supplied MIME types cannot force HTML execution.

A pending database record is created before S3 transfer and authorized again before becoming ready. Failed uploads attempt immediate cleanup; a worker removes pending uploads older than one hour. Removing a ready attachment immediately revokes application access but retains its object for 30 days, then the worker purges it. This retention helps backups but is not a complete point-in-time recovery policy. No attachment restore UI is implemented yet.

## Local S3 service

Compose runs the Apache-2.0-licensed SeaweedFS 4.08 mini service, pinned by OCI digest. Its S3 port is bound to loopback; other storage/admin ports are not exposed. setup:local generates credentials in ignored .env and a mode-0600 .local/s3.json identity file. There is no anonymous identity. The generated credentials are for local development, not a production IAM policy.

The mini service advertises loopback addresses internally because all its components share a container. This also keeps its internal RPC traffic local in proxied cloud environments. Existing proxy settings and CA verification are preserved. The initially attempted public MinIO image could not be fetched; no private registry token was required for the working SeaweedFS alternative.

Run pnpm storage:init after pnpm build and pnpm infra:up. It creates a missing bucket, verifies signed write/read integrity, verifies anonymous denial, and removes only its own random probe object. It does not rewrite an existing bucket's policy.

Production can use another S3-compatible service via environment variables. Supply appropriately scoped credentials, TLS, private bucket policy, retention, encryption and backup configuration through deployment settings. No production provider has been validated yet.

## Validation

Integration tests use isolated S3 buckets, verify unauthorized/read-only/CSRF rejection, byte-based preview MIME policy, non-ASCII filenames, download disposition, size limits, parent trash/restore, membership revocation, orphan cleanup and retention cleanup. Chromium uploads/downloads a real attachment. The runner removes only its own newly-created test buckets and removes empty prefix directories retained by SeaweedFS without disabling its protection against deleting nonempty buckets.
