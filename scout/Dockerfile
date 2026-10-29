# Frame Finder online: one container, data on a volume mounted at /data.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SCOUT_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY setup.mjs ./
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "src/server.ts"]
