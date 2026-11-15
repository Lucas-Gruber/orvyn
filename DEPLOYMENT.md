# Deployment status
Local Docker Compose PostgreSQL, Redis, SMTP testing and private S3-compatible storage are implemented with native Node application processes. Kubernetes, production container builds, ingress, TLS and external secret bindings remain incomplete. Do not use this as a production deployment guide.

For local setup see DEVELOPMENT.md. Production requires HTTPS, explicit ORVYN_ORIGIN, secure cookie configuration, secret injection, controlled migrations, backups and completion of the security items in SECURITY.md. Local database and object-bucket recovery is tested; see docs/BACKUP.md for its scope and remaining production requirements.
