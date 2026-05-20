ARG SHERPA_HARNESS_BASE_IMAGE=ghcr.io/openclaw/openclaw:2026.5.7
FROM ${SHERPA_HARNESS_BASE_IMAGE}

USER root

RUN if ! command -v bash >/dev/null || ! command -v git >/dev/null; then \
    apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git; \
  fi \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts README.md AGENTS.md ./
COPY docs ./docs
COPY fixtures ./fixtures
COPY prd ./prd
COPY packages ./packages
COPY harness ./harness

RUN chmod +x /workspace/harness/openclaw/entrypoint.sh /workspace/harness/openclaw/smoke.sh \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && openclaw_pkg="$(readlink -f /workspace/packages/openclaw/node_modules/openclaw)" \
  && rm -rf /workspace/packages/openclaw/node_modules /workspace/node_modules/openclaw \
  && ln -s "${openclaw_pkg}" /workspace/node_modules/openclaw

ENV OPENCLAW_HOME=/home/openclaw
ENV OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
ENV HOME=/home/openclaw
ENV OPENCLAW_GATEWAY_PORT=18789
ENV OPENCLAW_GATEWAY_TOKEN=sherpa-harness-token
ENV OPENCLAW_MODEL_PRIMARY=openai/gpt-5.4
ENV SHERPA_HARNESS_AGENT_ID=main

RUN if ! id -u openclaw >/dev/null 2>&1; then \
    useradd --create-home --shell /bin/bash openclaw; \
  fi \
  && mkdir -p /home/openclaw \
  && chown -R root:root /workspace /pnpm \
  && chown -R openclaw:openclaw /home/openclaw

USER root

ENTRYPOINT ["/workspace/harness/openclaw/entrypoint.sh"]
