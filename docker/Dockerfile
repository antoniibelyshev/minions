# minions runtime image. Build context: the installed minions package root
# (contains dist/, templates/, docker/, package.json). Built natively per architecture.
# Base pinned by multi-arch index digest (node:22-bookworm-slim, resolved 2026-10-19).
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base

# Bun runs the official Telegram channel plugin's MCP server (docs/design/telegram.md). Fetched in a
# throwaway stage (curl/unzip never reach the runtime image) and verified against pinned SHA-256
# checksums from the release's SHASUMS256.txt. x64 uses the baseline build (no AVX2 requirement).
FROM base AS bun
ARG BUN_VERSION=1.4.3
ARG BUN_SHA256_AARCH64=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21
ARG BUN_SHA256_X64_BASELINE=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      arm64) asset=bun-linux-aarch64; sum="$BUN_SHA256_AARCH64" ;; \
      amd64) asset=bun-linux-x64-baseline; sum="$BUN_SHA256_X64_BASELINE" ;; \
      *) echo "unsupported architecture for Bun" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}.zip"; \
    echo "${sum}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 "/tmp/bun/${asset}/bun" /usr/local/bin/bun; \
    test "$(/usr/local/bin/bun --version)" = "${BUN_VERSION}"

# GitHub CLI: official release tarball, pinned version, SHA-256 verified per architecture
# (values from gh_<version>_checksums.txt of the release). Both are fetched; the target one is used.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS gh
ARG GH_VERSION=2.102.0
ADD --checksum=sha256:bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 \
    https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz /gh/amd64.tar.gz
ADD --checksum=sha256:7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 \
    https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz /gh/arm64.tar.gz
ARG TARGETARCH
RUN mkdir /gh/out \
 && tar -xzf "/gh/${TARGETARCH}.tar.gz" -C /gh/out --strip-components=1 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" \
 && /gh/out/bin/gh --version | grep -q "^gh version ${GH_VERSION} "

# minions-sandbox: the isolation wrapper for process-harness workers (Landlock, seccomp, process-lifetime
# supervisor; docs/design/agent-runtimes.md D4), one small C file in docker/minions-sandbox/. Compiler image
# pinned by multi-arch index digest (gcc:14.3.0-bookworm, resolved 2026-10-23). The binary is static, so
# only it reaches the runtime image.
FROM gcc:14.3.0-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15 AS sandbox
COPY docker/minions-sandbox/minions-sandbox.c /src/minions-sandbox.c
RUN mkdir /out \
 && gcc -std=gnu11 -O2 -Wall -Wextra -fstack-protector-strong -D_FORTIFY_SOURCE=2 -static -s \
      -o /out/minions-sandbox /src/minions-sandbox.c \
 && /out/minions-sandbox --version | grep -q "^minions-sandbox 1.0.0 "


FROM base

ARG CLAUDE_CODE_VERSION=2.1.292
ARG BACKLOG_MD_VERSION=1.54.0

# Reviewed system packages only; nothing is installed as root at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux ca-certificates ripgrep less procps \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "backlog.md@${BACKLOG_MD_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=sandbox /out/minions-sandbox /usr/local/bin/minions-sandbox

# Real gh off PATH; /usr/local/bin/gh is the wrapper that reads the mounted token at exec time.
COPY --from=gh /gh/out/bin/gh /opt/gh/bin/gh
COPY docker/gh-wrapper.sh /usr/local/bin/gh
RUN chmod 0755 /opt/gh/bin/gh /usr/local/bin/gh /usr/local/bin/minions-sandbox

COPY package.json /opt/minions/pkg/package.json
COPY dist/ /opt/minions/pkg/dist/
COPY templates/ /opt/minions/pkg/templates/
RUN chmod 0755 /opt/minions/pkg/dist/cli.js \
 && ln -s /opt/minions/pkg/dist/cli.js /usr/local/bin/minions \
 # Mount points. Named volumes copy this ownership on first creation, so they are writable by node.
 && mkdir -p /workspace /state /home/node/.claude /home/node/.cache /opt/minions/plugin /opt/minions/config \
 && chown -R node:node /workspace /state /home/node \
 && test "$(id -u node)" = 1000

ENV MINIONS_RUNTIME=container \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    MINIONS_CONFIG=/opt/minions/config/config.json \
    DISABLE_AUTOUPDATER=1 \
    BUN_INSTALL_CACHE_DIR=/home/node/.cache/bun \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
