FROM node:24-bookworm AS node
FROM mongodb/mongodb-enterprise-server:8.0-ubuntu2204
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends krb5-kdc krb5-admin-server krb5-user libsasl2-modules-gssapi-mit python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY db ./db
COPY auth ./auth
COPY test/e2e-mongosh-kerberos.cjs ./test/
COPY test/fixtures/mongo-kerberos.sh /avvia.sh
ENTRYPOINT ["bash", "/avvia.sh"]
