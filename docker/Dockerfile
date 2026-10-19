# minions runtime image. Build context: the installed minions package root
# (contains dist/, templates/, docker/, package.json). Built natively per architecture.
# Base pinned by multi-arch index digest (node:22-bookworm-slim, resolved 2026-10-19).
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

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
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
