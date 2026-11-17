#!/usr/bin/env bash
set -euo pipefail

repo="${1:-${RESTIC_REPOSITORY:-}}"
if [[ -z "$repo" ]]; then
  echo "usage: $0 <direct-repository-path>" >&2
  exit 2
fi

export RESTIC_REPOSITORY="$repo"
restic forget --keep-hourly 48 --keep-daily 30 --keep-weekly 26 --prune
