FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.html ./
COPY server ./server
COPY pets ./pets

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/server.js"]
