# Pin base image digests before the first release.
FROM oven/bun:1-slim AS bun

FROM node:24-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV HUSKY=0
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
RUN bun install --frozen-lockfile --production

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/prompts ./prompts
COPY --from=build /repo/characters/example ./characters/example
COPY --from=build /repo/config.yml ./config.yml
USER node
VOLUME ["/data"]
EXPOSE 9881
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9881/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
