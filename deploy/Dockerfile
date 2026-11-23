# Pin base image digests before the first release.
FROM oven/bun:1-slim AS bun

# The manifest the dependency install sees: package.json without its version or the husky prepare script, so a
# release bump leaves the dependency layer as it was (docs/trd/deployment.md#release-image).
FROM node:24-slim AS deps-manifest
WORKDIR /m
COPY package.json ./
RUN node -e "const fs=require('node:fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.version;if(p.scripts)delete p.scripts.prepare;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

FROM node:24-slim AS prod-deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV HUSKY=0
WORKDIR /repo
COPY --from=deps-manifest /m/package.json ./package.json
COPY bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:24-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV HUSKY=0
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
# The owner site (docs/trd/site.md#serving-the-site), built here and served by the core under /app/.
RUN cd site && bun install --frozen-lockfile && bun run build

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

# Static musl builds pinned by the release SHA-256 checksums.
FROM debian:bookworm-slim AS typst
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
ARG TYPST_VERSION=v0.15.1
ARG TYPST_AMD64_SHA256=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
ARG TYPST_ARM64_SHA256=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) target=typst-x86_64-unknown-linux-musl; expected="$TYPST_AMD64_SHA256" ;; \
      arm64) target=typst-aarch64-unknown-linux-musl; expected="$TYPST_ARM64_SHA256" ;; \
      *) echo "Unsupported typst architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fLsS -o /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/$TYPST_VERSION/$target.tar.xz"; \
    echo "$expected  /tmp/typst.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/typst.tar.xz -C /tmp "$target/typst"; \
    install -m 0755 -o root -g root "/tmp/$target/typst" /usr/local/bin/typst; \
    rm -rf /tmp/typst.tar.xz "/tmp/$target"

# Static Go binaries pinned by the release SHA-256 checksums.
FROM debian:bookworm-slim AS restic
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_AMD64_SHA256=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
ARG RESTIC_ARM64_SHA256=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset="restic_${RESTIC_VERSION}_linux_amd64"; expected="$RESTIC_AMD64_SHA256" ;; \
      arm64) asset="restic_${RESTIC_VERSION}_linux_arm64"; expected="$RESTIC_ARM64_SHA256" ;; \
      *) echo "Unsupported restic architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fLsS -o /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v$RESTIC_VERSION/$asset.bz2"; \
    echo "$expected  /tmp/restic.bz2" | sha256sum -c -; \
    bzip2 -d /tmp/restic.bz2; \
    install -m 0755 -o root -g root /tmp/restic /usr/local/bin/restic; \
    rm -f /tmp/restic

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
RUN ln -s /opt/yt-dlp/yt-dlp /usr/local/bin/yt-dlp
COPY --from=typst /usr/local/bin/typst /usr/local/bin/typst
COPY --from=restic /usr/local/bin/restic /usr/local/bin/restic
ARG AIRA_BUILD_SHA=unknown
ENV AIRA_BUILD_SHA=$AIRA_BUILD_SHA
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/src/render/templates ./dist/src/render/templates
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
