FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
ARG MINE_AI_COMMIT=de4fef3260424d973bf81d0eaa15ff1a2f73ecff
ARG MINE_AI_FORK_REPOSITORY=https://github.com/jakemaly/mine-ai-mcp
ARG MINE_AI_FORK_COMMIT=a8ca9f9cfacd33be12448a4a55f97cc210a37b56
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mine-ai
COPY deploy/mine-ai-source/ /opt/mine-ai/
COPY deploy/mine-ai-source.commit /tmp/mine-ai-source.commit
RUN test "$(cat /tmp/mine-ai-source.commit)" = "${MINE_AI_FORK_COMMIT}" && bun install --frozen-lockfile --production
COPY deploy/viewer-package*.json /opt/viewer/
RUN cd /opt/viewer && cp viewer-package.json package.json && cp viewer-package-lock.json package-lock.json && bun install --frozen-lockfile --production --ignore-scripts && sed -i "s/require('canvas')/require('@napi-rs\/canvas')/g" node_modules/prismarine-viewer/viewer/lib/entities.js \
    && sed -i '/chunkColumnLoad: function (pos)/i\      chunkColumnUnload: function (pos) { worldView.unloadChunk(pos) },' node_modules/prismarine-viewer/viewer/lib/worldView.js
COPY deploy/viewer.mjs /opt/viewer/viewer.mjs
COPY deploy/inside.mjs /opt/mine-ai/inside.mjs
COPY deploy/viewer.patch /tmp/viewer.patch
RUN cd /opt/mine-ai && git apply /tmp/viewer.patch
LABEL org.opencontainers.image.revision="${MINE_AI_COMMIT}" \
      org.opencontainers.image.base-revision="${MINE_AI_COMMIT}" \
      org.opencontainers.image.source="${MINE_AI_FORK_REPOSITORY}" \
      org.opencontainers.image.fork-revision="${MINE_AI_FORK_COMMIT}"
ENTRYPOINT ["bun", "/opt/mine-ai/inside.mjs"]
