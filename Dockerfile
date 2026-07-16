FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Данные и загруженные фото должны пережить перезапуск контейнера —
# смонтируйте /app/data и /app/uploads как volume на реальном хостинге.
RUN mkdir -p data uploads

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
