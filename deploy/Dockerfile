# Pin base image digests before the first release.
FROM oven/bun:1-slim AS bun

FROM node:24-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV HUSKY=0
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
# The owner site (docs/trd/site.md#serving-the-site), built here and served by the core under /app/.
RUN cd site && bun install --frozen-lockfile && bun run build
RUN bun install --frozen-lockfile --production

# glibc onedir distributions; hashes match the pinned release's SHA2-256SUMS.
FROM debian:bookworm-slim AS ytdlp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_AMD64_SHA256=32e72032766bef9199d99d15beb69fd52e46df8f8b06f0d8745db59e04d339e9
ARG YTDLP_ARM64_SHA256=4e27ad43f3a34bacffd078694eb3edbb4e3b378e7da44edab2be02e98555516e
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset=yt-dlp_linux; expected="$YTDLP_AMD64_SHA256" ;; \
      arm64) asset=yt-dlp_linux_aarch64; expected="$YTDLP_ARM64_SHA256" ;; \
      *) echo "Unsupported yt-dlp architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"; \
    curl -fLsS -o /tmp/SHA2-256SUMS "$base/SHA2-256SUMS"; \
    release_sha256="$(awk -v asset="$asset.zip" '$2 == asset { print $1 }' /tmp/SHA2-256SUMS)"; \
    test "$release_sha256" = "$expected"; \
    curl -fLsS -o /tmp/yt-dlp.zip "$base/$asset.zip"; \
    echo "$expected  /tmp/yt-dlp.zip" | sha256sum -c -; \
    mkdir -p /opt/yt-dlp; \
    unzip -q /tmp/yt-dlp.zip -d /opt/yt-dlp; \
    chown -R root:root /opt/yt-dlp; \
    chmod -R a+rX,go-w /opt/yt-dlp; \
    ln -s "/opt/yt-dlp/$asset" /opt/yt-dlp/yt-dlp; \
    rm /tmp/yt-dlp.zip /tmp/SHA2-256SUMS

FROM node:24-slim
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
RUN ln -s /opt/yt-dlp/yt-dlp /usr/local/bin/yt-dlp
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/prompts ./prompts
COPY --from=build /repo/characters/example ./characters/example
COPY --from=build /repo/config.yml ./config.yml
COPY --from=build /repo/site/dist ./site/dist
USER node
VOLUME ["/data"]
EXPOSE 9881
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9881/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
