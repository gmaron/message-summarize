# syntax=docker/dockerfile:1
#
# message-summarize: the daemon and its web. Works for linux/amd64 and linux/arm64 (no architecture-specific commands).
#
# Build from the root of the repository (the context is the root, the Dockerfile is in docker/):
#   docker build -f docker/Dockerfile -t message-summarize .                 # the daemon, for the API and Ollama providers
#   docker build -f docker/Dockerfile --target cli -t message-summarize-cli .  # plus Claude Code, Gemini CLI and Codex
#
# Run it with the port published on the loopback of the host ONLY (RNF-03), and always as 8787 inside:
#   docker run -d --hostname message-summarize -p 127.0.0.1:8787:8787 -v msum-data:/data message-summarize
# Never use -P or -p 8787:8787 (that is every interface of the host). The web listens on 0.0.0.0 INSIDE the container
# (MSUM_WEB_HOST) and still requires its token. Prefer docker/compose.yaml, which sets all of this.
#
# All state (config, token, WhatsApp session, databases, models, the CLIs' logins) lives in the /data volume.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: compile the daemon and the web, then keep only the production dependencies -------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# vendor/sharp-stub: node_modules/sharp is a link to it (see package.json), so it must exist before npm ci.
COPY package.json package-lock.json .npmrc ./
COPY vendor/sharp-stub ./vendor/sharp-stub
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.core.json tsconfig.web.json vite.web.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- whisper: whisper.cpp at a pinned release; the model is downloaded at runtime by the app, never baked in ----------
FROM ${NODE_IMAGE} AS whisper
ARG WHISPER_CPP_VERSION=v1.9.5
# The commit the tag points to (the tag is annotated: this is its peeled commit). The build fails if they differ.
ARG WHISPER_CPP_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
# GGML_NATIVE=OFF: do not tune for the CPU that builds the image, so it runs on any machine of the same architecture.
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
    && test "$(git -C /src rev-parse HEAD)" = "${WHISPER_CPP_COMMIT}" \
    && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
        -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build /src/build --config Release --target whisper-cli -j"$(nproc)" \
    && strip /src/build/bin/whisper-cli

# ---- base: the runtime ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production \
    MSUM_DATA_DIR=/data \
    MSUM_WEB_HOST=0.0.0.0 \
    HOME=/data/home \
    TZ=UTC
# ffmpeg converts the audios for whisper (libgomp1: whisper-cli's OpenMP runtime); tini is PID 1 (reaps children, forwards SIGTERM); tzdata makes TZ work.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 tini tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown -R 1000:1000 /data \
    && ln -s /app/dist/main/cli.js /usr/local/bin/msum
WORKDIR /app
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/vendor ./vendor
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root docker ./docker
RUN chmod +x /app/docker/entrypoint.sh /app/dist/main/cli.js
# The node image already has a "node" user with uid 1000: rename it, so the container runs as "msum" (uid 1000).
RUN usermod -l msum -d /data/home node && groupmod -n msum node
USER msum
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "/app/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["msum", "daemon"]

# ---- cli: base + the LLM command line programs, for the providers that use a subscription --------------------------------
# Log in once inside the container (for example `docker compose -f docker/compose.yaml exec message-summarize claude`): the sessions are kept
# in HOME=/data/home, on the volume.
FROM base AS cli
ARG CLAUDE_CODE_VERSION=2.1.328
ARG GEMINI_CLI_VERSION=0.69.0
ARG CODEX_VERSION=0.170.0
# No self-update and no non-essential traffic (RNF-01): the versions are the pinned ones.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
USER root
RUN npm install -g --no-audit --no-fund \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force
USER msum

# ---- runtime: the default target of `docker build` (it must be the last stage): the base, without the CLIs -------------------
FROM base AS runtime
