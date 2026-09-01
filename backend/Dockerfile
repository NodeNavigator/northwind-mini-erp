FROM node:24-alpine
WORKDIR /app

# The image mirrors the repo layout exactly, including where node_modules lands.
# It previously flattened backend/src to /app/src, which made relative imports
# that worked in the container wrong in the checkout, and needed an existsSync
# branch in ops/boot.mjs to paper over it. One layout removes the whole class.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY backend ./backend
COPY ops ./ops
COPY db ./db

USER node
EXPOSE 3100
CMD ["node", "ops/boot.mjs"]
