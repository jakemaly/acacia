FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
ARG MINE_AI_COMMIT=de4fef3260424d973bf81d0eaa15ff1a2f73ecff
ARG MINE_AI_FORK_REPOSITORY=https://github.com/jakemaly/mine-ai-mcp
ARG MINE_AI_FORK_COMMIT=a8ca9f9cfacd33be12448a4a55f97cc210a37b56
ARG MINE_AI_FORK_WORKING_TREE=clean
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git chromium ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mine-ai
COPY deploy/mine-ai-source/ /opt/mine-ai/
COPY deploy/mine-ai-source.commit /tmp/mine-ai-source.commit
RUN test "$(cat /tmp/mine-ai-source.commit)" = "${MINE_AI_FORK_COMMIT}" && bun install --frozen-lockfile --production
COPY deploy/viewer-package*.json /opt/viewer/
RUN cd /opt/viewer && cp viewer-package.json package.json && cp viewer-package-lock.json package-lock.json && bun install --frozen-lockfile --production && sed -i "s/require('canvas')/require('@napi-rs\/canvas')/g" node_modules/prismarine-viewer/viewer/lib/entities.js \
    && sed -i '/chunkColumnLoad: function (pos)/i\      chunkColumnUnload: function (pos) { worldView.unloadChunk(pos) },' node_modules/prismarine-viewer/viewer/lib/worldView.js
COPY deploy/viewer.mjs /opt/viewer/viewer.mjs
COPY deploy/recording.mjs /opt/viewer/recording.mjs
COPY deploy/browser-recording.mjs /opt/viewer/browser-recording.mjs
COPY deploy/inside.mjs /opt/mine-ai/inside.mjs
COPY deploy/viewer.patch /tmp/viewer.patch
RUN cd /opt/viewer && bun -e 'import puppeteer from "puppeteer-core"; const browser = await puppeteer.launch({ headless: true, executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage", "--renderer-process-limit=2", "--num-raster-threads=2", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); const page = await browser.newPage(); const result = await page.evaluate(async () => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 8; const mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"].find(type => MediaRecorder.isTypeSupported(type)); if (!mimeType) throw new Error("Chromium has no WebM encoder."); const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType }); const chunks = []; recorder.ondataavailable = event => chunks.push(event.data); const stopped = new Promise(resolve => recorder.onstop = resolve); recorder.start(); await new Promise(resolve => setTimeout(resolve, 250)); recorder.stop(); await stopped; const blob = new Blob(chunks, { type: mimeType }); const bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer()); return { size: blob.size, signature: Array.from(bytes) }; }); await browser.close(); if (result.size < 4 || result.signature.join(",") !== "26,69,223,163") throw new Error(`WebM capture smoke failed: ${JSON.stringify(result)}`);' \
    && ffmpeg -hide_banner -encoders 2>&1 | grep -q libvpx \
    && cd /opt/mine-ai && git apply /tmp/viewer.patch
LABEL org.opencontainers.image.revision="${MINE_AI_COMMIT}" \
      org.opencontainers.image.base-revision="${MINE_AI_COMMIT}" \
      org.opencontainers.image.source="${MINE_AI_FORK_REPOSITORY}" \
      org.opencontainers.image.fork-revision="${MINE_AI_FORK_COMMIT}" \
      org.opencontainers.image.fork-working-tree="${MINE_AI_FORK_WORKING_TREE}"
ENTRYPOINT ["bun", "/opt/mine-ai/inside.mjs"]
