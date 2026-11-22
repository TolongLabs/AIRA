#!/bin/sh
set -eu
# The owner service trusts loopback without a token. Connect via the host's Docker
# bridge address and prove the sensitive read rejects an anonymous caller first.
gateway=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
origin="http://${gateway}:6769"
status=$(curl --noproxy '*' -sS --max-time 5 -o /dev/null -w '%{http_code}' "$origin/api/settings")
[ "$status" = 401 ] || { echo 'Owner API did not enforce authentication' >&2; exit 1; }
exec /usr/lib/systemd/systemd-socket-proxyd "$gateway:6769"
