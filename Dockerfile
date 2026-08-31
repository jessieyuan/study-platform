FROM node:22-alpine

WORKDIR /app

# 拷贝项目文件（不含 server/data.db，云端数据库走持久卷）
COPY index.html package.json ./
COPY server ./server
COPY pets ./pets
COPY img ./img

ENV NODE_ENV=production

# Cloud Run 等平台通过 PORT 环境变量指定端口，默认 3000
EXPOSE 3000

CMD ["node", "--experimental-sqlite", "server/server.js"]
