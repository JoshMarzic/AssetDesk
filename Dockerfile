FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
# Optional CA for managed cloud builds. TLS verification stays enabled.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --strict-ssl=true
COPY --chown=node:node src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/assetdesk.sqlite
EXPOSE 3000
CMD ["node", "src/server.js"]
