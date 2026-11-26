FROM node:24-alpine

# Certificati SSH e dispositivi FIDO usano il client nativo e il suo helper.
RUN apk add --no-cache openssh-client-default openssh-sk-helper

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev \
  && rm -rf node_modules/electron-updater node_modules/@types \
  && find node_modules -type d \( -name '@types' -o -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'docs' -o -name 'example' -o -name 'examples' \) -prune -exec rm -rf {} + \
  && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname 'readme*.md' -o -iname 'changelog*.md' -o -iname 'history*.md' \) -delete \
  && rm -f package-lock.json

COPY server.js electron-server-auth.js LICENSE.md EULA.md MANLEVA.md ./
COPY auth ./auth
COPY backup ./backup
COPY db ./db
COPY mcp ./mcp
COPY server ./server
COPY public ./public
COPY bin ./bin

# connections.ini e backups/ vivono fuori dall'immagine (montati come volumi
# in docker-compose.yml) cosi' sopravvivono alla ricreazione del container.
RUN mkdir -p /app/data /app/backups && chown -R node:node /app

USER node

EXPOSE 3030

ENV PORT=3030
# Dentro un container 0.0.0.0 è l'unico bind sensato: è l'indirizzo INTERNO,
# non l'esposizione. Ciò che decide chi può raggiungere CodeDB è come la porta
# viene pubblicata (`ports:` in docker-compose.yml) e cosa c'e' davanti.
ENV HOST=0.0.0.0
# Dove la porta è PUBBLICATA: è questo, non HOST, che decide chi può raggiungere
# CodeDB, ed è ciò che il server controlla prima di partire (bindEsposto in
# server.js). Il compose la ricava da BIND_ADDR (loopback salvo scelta esplicita),
# così una sola variabile in .env resta la fonte di verità.
#
# Senza compose si presume esposizione in rete: avvio consentito solo con TLS
# e autenticazione dichiarati. Per un docker run esclusivamente locale servono
# sia -p 127.0.0.1:3030:3030 sia -e CODEDB_PUBLIC_BIND=127.0.0.1.
ENV CODEDB_PUBLIC_BIND=0.0.0.0
ENV CODEDB_CONNECTIONS_FILE=/app/data/connections.ini
ENV CODEDB_UI_AUDIT_FILE=/app/data/ui-audit.log
ENV CODEDB_MCP_AUDIT_FILE=/app/data/mcp-audit.log
ENV CODEDB_MCP_SETTINGS_FILE=/app/data/mcp-settings.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3030)+'/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
