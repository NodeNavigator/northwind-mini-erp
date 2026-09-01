FROM node:24-alpine
WORKDIR /app
COPY frontend/package.json ./
COPY frontend/server.mjs ./
COPY frontend/web ./web
USER node
EXPOSE 3200
CMD ["node", "server.mjs"]
