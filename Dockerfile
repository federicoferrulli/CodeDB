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
ENV HOST=0.0.0.0
ENV CODEDB_CONNECTIONS_FILE=/app/data/connections.ini

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3030)+'/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
