FROM node:22-alpine AS pwa
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm install
COPY pwa ./pwa
COPY daemon ./daemon
RUN npm run build:pwa

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY daemon ./daemon
COPY --from=pwa /src/pwa/dist ./pwa
ENV NODE_ENV=production
ENV PWA_DIR=/app/pwa
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["npx", "tsx", "daemon/src/index.ts"]
