# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/collaboration/package.json apps/collaboration/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/editor/package.json packages/editor/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=orvyn-pnpm,target=/pnpm/store --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY apps ./apps
COPY packages ./packages
RUN pnpm -r build
RUN --mount=type=cache,id=orvyn-pnpm,target=/pnpm/store --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm --store-dir /pnpm/store --filter @orvyn/api deploy --prod --frozen-lockfile /opt/api && \
    pnpm --store-dir /pnpm/store --filter @orvyn/collaboration deploy --prod --frozen-lockfile /opt/collaboration

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ARG VERSION=development
ARG REVISION=unknown
ARG SOURCE=https://github.com/Lucas-Gruber/orvyn
LABEL org.opencontainers.image.title="Orvyn" org.opencontainers.image.version=$VERSION org.opencontainers.image.revision=$REVISION org.opencontainers.image.source=$SOURCE
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS web
COPY --from=build --chown=node:node /app/apps/web/.output ./.output
ENV NITRO_HOST=0.0.0.0 NITRO_PORT=3000 NUXT_PUBLIC_COLLABORATION_URL=""
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.NITRO_PORT||3000)+'/api/v1/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]

FROM runtime AS api
COPY --from=build --chown=node:node /opt/api ./
ENV PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM api AS worker
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]

FROM runtime AS collaboration
COPY --from=build --chown=node:node /opt/collaboration ./
ENV COLLABORATION_PORT=3002
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.COLLABORATION_PORT||3002)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
