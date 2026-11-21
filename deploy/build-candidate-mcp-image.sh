#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fork_dir="${MINE_AI_FORK_DIR:?Set MINE_AI_FORK_DIR to the MCP checkout to build}"
image_tag="${MINE_AI_CANDIDATE_IMAGE:-minecraft-mine-ai:candidate}"
upstream_base="$(sed -n "s/^const revision = '\\([0-9a-f]\\{40\\}\\)';$/\\1/p" "$repo_dir/src/run.mjs")"
fork_repository="$(sed -n "s/^const forkRepository = '\\([^']*\\)';$/\\1/p" "$repo_dir/src/run.mjs")"

if [[ ! -d "$fork_dir/.git" && ! -f "$fork_dir/.git" ]]; then
  printf 'MINE_AI_FORK_DIR is not a Git checkout: %s\n' "$fork_dir" >&2
  exit 1
fi
fork_commit="$(git -C "$fork_dir" rev-parse HEAD)"
if [[ ! "$upstream_base" =~ ^[0-9a-f]{40}$ || ! "$fork_repository" =~ ^https:// ]]; then
  printf 'Could not read the pinned Mine AI base and repository from %s/src/run.mjs\n' "$repo_dir" >&2
  exit 1
fi
git -C "$fork_dir" merge-base --is-ancestor "$upstream_base" "$fork_commit" || {
  printf 'Candidate checkout %s is not based on pinned upstream %s\n' "$fork_commit" "$upstream_base" >&2
  exit 1
}

working_tree=clean
if [[ -n "$(git -C "$fork_dir" status --porcelain --untracked-files=all)" ]]; then
  working_tree=dirty
fi

context="$(mktemp -d "${TMPDIR:-/tmp}/minecraft-mcp-candidate.XXXXXX")"
trap 'rm -rf -- "$context"' EXIT
mkdir -p "$context/deploy/mine-ai-source"
for file in Dockerfile inside.mjs viewer.mjs recording.mjs browser-recording.mjs viewer.patch \
  viewer-package.json viewer-package-lock.json; do
  cp -- "$repo_dir/deploy/$file" "$context/deploy/$file"
done
printf '%s\n' "$fork_commit" > "$context/deploy/mine-ai-source.commit"

# Use Git's tracked and non-ignored files so local caches and ignored credentials never enter the image.
git -C "$fork_dir" ls-files -co --exclude-standard -z \
  | while IFS= read -r -d '' file; do
      case "$file" in
        .env|*/.env|.env.*|*/.env.*) continue ;;
      esac
      if [[ -e "$fork_dir/$file" ]]; then printf '%s\0' "$file"; fi
    done \
  | tar --create --file=- --directory="$fork_dir" --null --files-from=- \
  | tar --extract --file=- --directory="$context/deploy/mine-ai-source"

docker build \
  --build-arg "MINE_AI_COMMIT=$upstream_base" \
  --build-arg "MINE_AI_FORK_REPOSITORY=$fork_repository" \
  --build-arg "MINE_AI_FORK_COMMIT=$fork_commit" \
  --build-arg "MINE_AI_FORK_WORKING_TREE=$working_tree" \
  --file "$context/deploy/Dockerfile" \
  --tag "$image_tag" \
  "$context"

docker image inspect --format 'image={{.Id}} base={{index .Config.Labels "org.opencontainers.image.base-revision"}} fork={{index .Config.Labels "org.opencontainers.image.fork-revision"}} working-tree={{index .Config.Labels "org.opencontainers.image.fork-working-tree"}}' "$image_tag"
