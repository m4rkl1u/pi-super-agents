#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: bash scripts/install.sh [--user | --global] [--prefix PATH] [--uninstall]' \
    '' \
    'Default: install super-agents for the current user in ~/.local.' \
    '--user         Use ~/.local (default).' \
    '--global       Use the configured npm global prefix.' \
    '--prefix PATH  Override the install prefix (e.g. /usr/local for all users).' \
    '--uninstall    Remove the application, keeping workspace data and Pi settings.' \
    '--help, -h     Show this help.' \
    '' \
    'Run again from updated source to upgrade. Node >=22.19.0 and npm are required.'
}

scope=user
prefix=''
action=install
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) scope=user ;;
    --global) scope=global ;;
    --prefix)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == -* ]]; then
        printf '%s\n' 'Error: --prefix requires a path.' >&2
        exit 1
      fi
      prefix=$2
      shift
      ;;
    --uninstall) action=uninstall ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Error: unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

for command in node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Error: %s is required and must be on PATH.\n' "$command" >&2
    exit 1
  fi
done
if [ -z "$prefix" ]; then
  if [ "$scope" = global ]; then
    prefix=$(npm prefix --global)
  else
    prefix="${HOME:?HOME must be set for a user installation}/.local"
  fi
fi
prefix=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' -- "$prefix")

if [ "$action" = uninstall ]; then
  npm uninstall --global --prefix "$prefix" --ignore-scripts --no-audit --no-fund -- pi-agent-workspace
  printf 'Removed super-agents from %s. Workspace data and Pi settings were kept.\n' "$prefix"
  exit 0
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error("Error: Node >=22.19.0 is required; found " + process.versions.node); process.exit(1); }'
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [ ! -f "$root/src/cli.ts" ] || [ ! -f "$root/package-lock.json" ]; then
  printf '%s\n' 'Error: installation requires the source directory, including src/ and package-lock.json.' >&2
  exit 1
fi
archive_dir=$(mktemp -d)
trap 'rm -rf -- "$archive_dir"' EXIT
(
  cd -- "$root"
  npm ci --include=dev --ignore-scripts --no-audit --no-fund
  npm run build
  npm pack --ignore-scripts --pack-destination "$archive_dir"
)
# Install an archive, not a directory link, so the source can be moved or deleted.
npm install --global --prefix "$prefix" --ignore-scripts --no-audit --no-fund -- "$archive_dir"/*.tgz
printf '\nInstalled super-agents in %s/bin. Run: super-agents --help\n' "$prefix"
case ":${PATH:-}:" in
  *":$prefix/bin:"*) ;;
  *) printf 'Add this directory to PATH in your shell profile (bash/zsh):\n  export PATH=%q/bin:"$PATH"\n' "$prefix" ;;
esac
