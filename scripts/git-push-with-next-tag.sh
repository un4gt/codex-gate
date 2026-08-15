#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/git-push-with-next-tag.sh [--remote origin]

Behavior:
  1. Require the current branch to be main
  2. Require a clean working tree
  3. Run the complete prek pre-push release gate
  4. Find latest tag matching vX.Y.Z
  5. Create next patch tag (for example v0.0.23 -> v0.0.24)
  6. Push main and the new tag together

Options:
  --remote <name>   Remote name, default: origin
  -h, --help        Show this help
EOF
}

remote_name="origin"
release_branch="main"

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

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
  echo "detached HEAD is not supported" >&2
  exit 1
fi

if [[ "$current_branch" != "$release_branch" ]]; then
  echo "release tags can only be created from ${release_branch}; current branch: ${current_branch}" >&2
  echo "push this branch normally, merge it into ${release_branch}, then run this script from ${release_branch}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash changes before creating a release tag" >&2
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

echo "==> running prek pre-push release gate"
bash scripts/run-prek-checks.sh pre-push

echo "==> creating tag ${next_tag}"
git tag "$next_tag"

echo "==> pushing branch and tag"
git push --atomic "$remote_name" "$current_branch" "$next_tag"

echo "done: ${next_tag}"
