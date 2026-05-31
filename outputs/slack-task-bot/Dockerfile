FROM node:22-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY prisma ./prisma

RUN npm install
RUN npm run prisma:generate

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

CMD ["npm", "run", "start:prod"]
