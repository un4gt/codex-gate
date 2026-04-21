#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/git-push-with-next-tag.sh [--remote origin] [--allow-dirty]

Behavior:
  1. Push current branch to remote
  2. Find latest tag matching vX.Y.Z
  3. Create next patch tag (for example v0.0.23 -> v0.0.24)
  4. Push tags to remote

Options:
  --remote <name>   Remote name, default: origin
  --allow-dirty     Skip working tree clean check
  -h, --help        Show this help
EOF
}

remote_name="origin"
allow_dirty="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      if [[ $# -lt 2 ]]; then
        echo "missing value for --remote" >&2
        exit 1
      fi
      remote_name="$2"
      shift 2
      ;;
    --allow-dirty)
      allow_dirty="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "current directory is not a git repository" >&2
  exit 1
fi

if ! git remote get-url "$remote_name" >/dev/null 2>&1; then
  echo "remote not found: $remote_name" >&2
  exit 1
fi

if [[ "$allow_dirty" != "true" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash changes first, or use --allow-dirty" >&2
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
  echo "detached HEAD is not supported" >&2
  exit 1
fi

latest_tag="$(
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' \
    | sort -V \
    | tail -n 1
)"

if [[ -z "$latest_tag" ]]; then
  next_tag="v0.0.1"
else
  version="${latest_tag#v}"
  IFS='.' read -r major minor patch <<<"$version"
  if [[ -z "${major:-}" || -z "${minor:-}" || -z "${patch:-}" ]]; then
    echo "invalid latest tag format: $latest_tag" >&2
    exit 1
  fi
  if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]]; then
    echo "invalid latest tag format: $latest_tag" >&2
    exit 1
  fi
  next_tag="v${major}.${minor}.$((patch + 1))"
fi

if git rev-parse "$next_tag" >/dev/null 2>&1; then
  echo "tag already exists: $next_tag" >&2
  exit 1
fi

echo "remote: ${remote_name}"
echo "branch: ${current_branch}"
echo "latest tag: ${latest_tag:-<none>}"
echo "next tag: ${next_tag}"

echo "==> pushing branch"
git push "$remote_name" "$current_branch"

echo "==> creating tag ${next_tag}"
git tag "$next_tag"

echo "==> pushing tags"
git push "$remote_name" --tags

echo "done: ${next_tag}"
