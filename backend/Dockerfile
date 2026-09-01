FROM node:24-alpine
WORKDIR /app

# Build context is the repo root, so paths are repo-relative. package.json is
# copied alone first: `npm install` then sits in a cached layer that source
# edits do not invalidate.
COPY backend/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY backend/src ./src
COPY backend/test ./test
COPY ops ./ops
COPY db ./db

# Non-root. The image ships no shell tooling it does not need, and the process
# has no write access to its own source.
USER node
EXPOSE 3100
CMD ["node", "ops/boot.mjs"]
