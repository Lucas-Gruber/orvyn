# Deployment status
Only local Docker Compose PostgreSQL and native Node development processes are implemented. Kubernetes, production container builds, ingress, TLS, external secret bindings, Redis and S3 are not implemented. Do not use this as a production deployment guide.

For local setup see DEVELOPMENT.md. Production requires HTTPS, explicit ORVYN_ORIGIN, secure cookie configuration, secret injection, controlled migrations, backups and completion of the security items in SECURITY.md. No restore path has been validated.
