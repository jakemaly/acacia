#!/usr/bin/env bash
set -euo pipefail

upstream_base='de4fef3260424d973bf81d0eaa15ff1a2f73ecff'
fork_repository='https://github.com/jakemaly/mine-ai-mcp'
fork_branch='acacia-compat'
fork_commit='12d55d41f2084dca20eb33451d22f839bf8b7101'
fork_dir="${MINE_AI_FORK_DIR:-$HOME/.local/src/mine-ai-mcp}"
source_dir="$(pwd)/deploy/mine-ai-source"
image_tag='minecraft-mine-ai:acacia-fork-compat'

git -C "$fork_dir" fetch --no-tags origin "refs/heads/$fork_branch:refs/remotes/origin/$fork_branch"
remote_commit="$(git -C "$fork_dir" rev-parse "refs/remotes/origin/$fork_branch")"
if [[ "$remote_commit" != "$fork_commit" ]]; then
  printf 'Pinned fork commit mismatch: expected %s, found %s\n' "$fork_commit" "$remote_commit" >&2
  exit 1
fi
git -C "$fork_dir" merge-base --is-ancestor "$upstream_base" "$fork_commit"

# Export tracked files only so Git credentials and local repository config never enter the build context.
rm -rf "$source_dir"
mkdir -p "$source_dir"
git -C "$fork_dir" archive --format=tar "$fork_commit" | tar -xf - -C "$source_dir"
printf '%s\n' "$fork_commit" > deploy/mine-ai-source.commit

docker build \
  --build-arg "MINE_AI_COMMIT=$upstream_base" \
  --build-arg "MINE_AI_FORK_REPOSITORY=$fork_repository" \
  --build-arg "MINE_AI_FORK_COMMIT=$fork_commit" \
  --file deploy/Dockerfile \
  --tag "$image_tag" \
  .

docker image inspect --format 'image={{.Id}} base={{index .Config.Labels "org.opencontainers.image.base-revision"}} fork={{index .Config.Labels "org.opencontainers.image.fork-revision"}}' "$image_tag"
