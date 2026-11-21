#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
commit="$(git rev-parse HEAD)"
working_tree=clean
if [[ -n "$(git status --porcelain --untracked-files=all -- mine-ai-mcp deploy/Dockerfile deploy/inside.mjs deploy/viewer.mjs deploy/recording.mjs deploy/browser-recording.mjs deploy/viewer.patch deploy/viewer-package.json deploy/viewer-package-lock.json)" ]]; then
  working_tree=dirty
fi

context="$(mktemp -d "${TMPDIR:-/tmp}/acacia-bot-build.XXXXXX")"
trap 'rm -rf -- "$context"' EXIT
mkdir -p "$context/deploy/mine-ai-source"
for file in Dockerfile inside.mjs viewer.mjs recording.mjs browser-recording.mjs viewer.patch \
  viewer-package.json viewer-package-lock.json; do
  cp -- "deploy/$file" "$context/deploy/$file"
done

# Snapshot tracked and new source files together so the image describes exactly what was built.
git ls-files -co --exclude-standard -z -- mine-ai-mcp \
  | while IFS= read -r -d '' file; do
      if [[ -e "$file" || -L "$file" ]]; then printf '%s\0' "$file"; fi
    done \
  | tar --create --file="$context/source.tar" --null --files-from=- --transform='s,^mine-ai-mcp/,,'
source_digest="$(sha256sum "$context/source.tar" | cut -d ' ' -f 1)"
tar --extract --file="$context/source.tar" --directory="$context/deploy/mine-ai-source"
rm "$context/source.tar"
printf '%s\n' "$commit" > "$context/deploy/mine-ai-source.commit"

image_tag='minecraft-mine-ai:acacia-fork-compat'
temporary_tag="minecraft-mine-ai:build-$$"
previous_image="$(docker image inspect --format '{{.Id}}' "$image_tag" 2>/dev/null || true)"
docker build \
  --build-arg "MINE_AI_FORK_REPOSITORY=https://github.com/jakemaly/acacia" \
  --build-arg "MINE_AI_FORK_COMMIT=$commit" \
  --build-arg "MINE_AI_FORK_WORKING_TREE=$working_tree" \
  --build-arg "ACACIA_SOURCE_COMMIT=$commit" \
  --build-arg "ACACIA_SOURCE_WORKING_TREE=$working_tree" \
  --build-arg "ACACIA_SOURCE_DIGEST=$source_digest" \
  --file "$context/deploy/Dockerfile" --tag "$temporary_tag" "$context"
if [[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  docker tag "$previous_image" minecraft-mine-ai:previous
fi
docker tag "$temporary_tag" "$image_tag"
docker image rm "$temporary_tag"
docker image inspect --format 'image={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.acacia-revision"}} working-tree={{index .Config.Labels "org.opencontainers.image.acacia-working-tree"}}' "$image_tag"
