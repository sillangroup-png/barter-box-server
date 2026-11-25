FROM node:18-slim

WORKDIR /app

# 25.11.2026: договор блогеру в PDF — LibreOffice (только Writer, без GUI) + шрифты, совместимые с Times New Roman
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Данные и загруженные фото должны пережить перезапуск контейнера —
# смонтируйте /app/data и /app/uploads как volume на реальном хостинге.
RUN mkdir -p data uploads

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
