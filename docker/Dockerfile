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
# OpenAI Codex CLI for process-harness workers (docs/design/agent-runtimes.md, task-14.6 addendum). npm integrity of
# @openai/codex@0.164.0: sha512-TWj7UGyPRe3Pj/A3ddNAxs1te3a/W/xAd+J0LHrrFTmsSfahGMOLF/vn88D3QCIgAT3B1rm1y/Z3NYE0rx6cZQ==
ARG CODEX_VERSION=0.164.0

# Reviewed system packages only; nothing is installed as root at runtime. curl, xz and unzip fetch toolchains into /opt/tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux ca-certificates ripgrep less procps curl xz-utils unzip \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "backlog.md@${BACKLOG_MD_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=sandbox /out/minions-sandbox /usr/local/bin/minions-sandbox
RUN chmod 0755 /usr/local/bin/minions-sandbox

COPY package.json /opt/minions/pkg/package.json
COPY dist/ /opt/minions/pkg/dist/
COPY templates/ /opt/minions/pkg/templates/
RUN chmod 0755 /opt/minions/pkg/dist/cli.js \
 && ln -s /opt/minions/pkg/dist/cli.js /usr/local/bin/minions \
 # Mount points. Named volumes copy this ownership on first creation, so they are writable by node.
 # /opt/tools is the tools volume (docs/design/autonomy.md Decision 14): toolchains the agents install without root.
 && mkdir -p /workspace /state /home/node/.claude /home/node/.cache /opt/minions/plugin /opt/minions/config \
      /opt/tools/bin /opt/tools/cargo /opt/tools/rustup /opt/tools/go /opt/tools/uv \
 && chown -R node:node /workspace /state /home/node /opt/tools \
 # Login shells reset PATH from /etc/profile: keep the tools on it there too.
 && printf 'case ":$PATH:" in *:/opt/tools/bin:*) ;; *) PATH="$PATH:/opt/tools/bin:/opt/tools/cargo/bin:/opt/tools/go/bin:/opt/tools/goroot/bin" ;; esac\n' > /etc/profile.d/minions-tools.sh \
 && test "$(id -u node)" = 1000

# The tools locations and PATH: the same values as TOOLS_ENV and CONTAINER_PATH in src/core/paths.ts.
ENV MINIONS_RUNTIME=container \
    MINIONS_CODEX_VERSION=${CODEX_VERSION} \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    MINIONS_CONFIG=/opt/minions/config/config.json \
    DISABLE_AUTOUPDATER=1 \
    BUN_INSTALL_CACHE_DIR=/home/node/.cache/bun \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CARGO_HOME=/opt/tools/cargo \
    RUSTUP_HOME=/opt/tools/rustup \
    GOPATH=/opt/tools/go \
    UV_INSTALL_DIR=/opt/tools/bin \
    UV_TOOL_DIR=/opt/tools/uv/tools \
    UV_TOOL_BIN_DIR=/opt/tools/bin \
    UV_PYTHON_INSTALL_DIR=/opt/tools/uv/python \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/tools/bin:/opt/tools/cargo/bin:/opt/tools/go/bin:/opt/tools/goroot/bin

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
