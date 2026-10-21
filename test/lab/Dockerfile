FROM node:24-bookworm
# Librerie del browser nell'immagine, così sopravvivono alla ricreazione del runner.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
    libgbm1 libnspr4 libnss3 libx11-6 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 libglib2.0-0 libfontconfig1 libcairo2 \
    libpango-1.0-0 fonts-liberation fonts-noto-color-emoji xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
