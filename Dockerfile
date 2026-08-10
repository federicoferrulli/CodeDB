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
# Dove la porta è PUBBLICATA: è questo, non HOST, che decide chi può raggiungere
# CodeDB, ed è ciò che il server controlla prima di partire (bindEsposto in
# server.js). Il default vale "pubblicata su loopback", che è quello che fa
# docker-compose.yml salvo scelta contraria; il compose la ricava da BIND_ADDR,
# così una sola variabile in .env resta la fonte di verità.
#
# ATTENZIONE per chi usa `docker run` a mano: pubblicando la porta su un
# indirizzo raggiungibile dalla rete (`-p 0.0.0.0:3030:3030`) va dichiarato
# anche qui `-e CODEDB_PUBLIC_BIND=0.0.0.0`, altrimenti il server crede di
# essere su loopback e non applica né il controllo su HTTPS né quello
# sull'autenticazione. Prima questa immagine impostava CODEDB_TRUST_PROXY_TLS=1
# in modo fisso, che li disattivava entrambi in ogni caso.
ENV CODEDB_PUBLIC_BIND=127.0.0.1
ENV CODEDB_CONNECTIONS_FILE=/app/data/connections.ini

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3030)+'/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
