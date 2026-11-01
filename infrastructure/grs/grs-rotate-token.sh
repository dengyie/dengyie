#!/usr/bin/env bash
# Rotate the github-readme-stats service token on the VPS.
# Canonical source: dengyie/dengyie infrastructure/grs/ (deployed to /usr/local/sbin/).
#
# Usage:  grs-rotate-token.sh <new_token>
#
# Writes the token atomically (root:grs 0640), restarts grs.service, then
# self-checks by fetching a cache-busted card (t= param forces a real GitHub API
# call, so an invalid token fails the check instead of being masked by cache).
set -euo pipefail

TOKEN_FILE=/etc/grs/github_token
SERVICE=grs.service
CHECK=/tmp/grs-rotate-check.$$.svg

[[ $# -eq 1 ]] || { echo "usage: $0 <new_token>" >&2; exit 2; }
NEW_TOKEN=$1
[[ ${#NEW_TOKEN} -ge 40 ]] || { echo "refusing: token looks too short (<40 chars)" >&2; exit 2; }

umask 077
printf '%s\n' "$NEW_TOKEN" > "$TOKEN_FILE.new"
chown root:grs "$TOKEN_FILE.new"
chmod 640 "$TOKEN_FILE.new"
mv "$TOKEN_FILE.new" "$TOKEN_FILE"

systemctl restart "$SERVICE"
sleep 2

code=$(curl -sS -o "$CHECK" -w '%{http_code}' \
  "http://127.0.0.1/index?username=dengyie&show_icons=true&t=$(date +%s)" || true)

if [[ $code == 200 ]] && ! grep -q "Something went wrong" "$CHECK"; then
  echo "rotate OK: fresh card 200 via new token"
  rm -f "$CHECK"
else
  echo "rotate FAILED: card http=$code (token not applied?); file kept at $TOKEN_FILE" >&2
  rm -f "$CHECK"
  exit 1
fi
