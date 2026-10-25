FROM node:24-alpine

# Certificati SSH e dispositivi FIDO usano il client nativo e il suo helper.
RUN apk add --no-cache openssh-client-default openssh-sk-helper

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3030)+'/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
