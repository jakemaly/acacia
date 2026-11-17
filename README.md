# Acacia: Long-Horizon Minecraft Agent
Acacia empowers large language models (LLMs) to embody a stateful player in digital environment, and to take actions within it.

## Intro
<img width="1228" height="970" alt="image" src="https://github.com/user-attachments/assets/710917e8-ee35-4d98-8776-74ef3f58fd50" />

## Run locally

Use Linux, Node 24.15+, and Docker Engine 28+ with isolated bridge support.

```sh
npm ci
docker pull eclipse-temurin:21-jre@sha256:a80c51f2d09a3e7e00d521f1c817bbceb6b3be94109b4a784d46078099882dda
MINE_AI_FORK_DIR="$HOME/.local/src/mine-ai-mcp" bash deploy/build-private-mcp-image.sh
npm start
```
