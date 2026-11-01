# Tevro 서버 이미지. 데이터는 /data 볼륨(tevro.db)에 둔다.
#   docker build -t tevro .
#   docker run -d --name tevro -p 4000:4000 -v tevro-data:/data tevro
#   docker logs tevro        # 처음 켜면 첫 관리자 설정 코드가 나온다

FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3의 미리 빌드된 파일을 받지 못하면 직접 빌드한다.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    TEVRO_DATA_DIR=/data \
    TEVRO_IN_DOCKER=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/trial ./trial
COPY --from=build /app/LICENSE /app/NOTICE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/server/main.ts"]
