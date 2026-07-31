FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

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
# Senza questa dichiarazione il server rifiuta di partire fuori dal loopback,
# perché parla solo HTTP (vedi assertTransportSafe in server.js): qui la si
# imposta perché il bind è interno al container. RESTA A CARICO DI CHI
# DISTRIBUISCE mettere un reverse proxy HTTPS davanti alla porta pubblicata e
# accendere CODEDB_RBAC=on se il servizio esce dalla macchina: all'avvio il
# server lo ricorda con un avviso esplicito.
ENV CODEDB_TRUST_PROXY_TLS=1
ENV CODEDB_CONNECTIONS_FILE=/app/data/connections.ini

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3030)+'/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
