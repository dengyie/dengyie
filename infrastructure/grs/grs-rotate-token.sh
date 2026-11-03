#!/usr/bin/env bash
# Rotate the shared GitHub service token on the VPS (grs + streak-stats consumers).
# Canonical source: dengyie/dengyie infrastructure/grs/ (deployed to /usr/local/sbin/).
#
# Usage:  grs-rotate-token.sh <new_token>
#
# Both services share one PAT: grs reads /etc/grs/github_token, the streak-stats
# PHP app reads TOKEN= from /etc/streak/streak.env. This script writes both
# atomically, restarts both services, then self-checks both by fetching
# cache-busted cards (t= forces a real GitHub API call, so an invalid token fails
# the check instead of being masked by cache).
set -euo pipefail

TOKEN_FILE=/etc/grs/github_token
SERVICE=grs.service
STREAK_ENV=/etc/streak/streak.env
STREAK_SERVICE=streak-stats.service
CHECK=/tmp/grs-rotate-check.$$.svg
CHECK2=/tmp/grs-rotate-check2.$$.svg

[[ $# -eq 1 ]] || { echo "usage: $0 <new_token>" >&2; exit 2; }
NEW_TOKEN=$1
[[ ${#NEW_TOKEN} -ge 40 ]] || { echo "refusing: token looks too short (<40 chars)" >&2; exit 2; }

umask 077

# grs: raw token file.
printf '%s\n' "$NEW_TOKEN" > "$TOKEN_FILE.new"
chown root:grs "$TOKEN_FILE.new"
chmod 640 "$TOKEN_FILE.new"
mv "$TOKEN_FILE.new" "$TOKEN_FILE"

# streak-stats: env file with TOKEN= plus the WHITELIST line. Preserve any
# WHITELIST edit made directly on the VPS instead of silently reverting it.
WHITELIST=$(grep -m1 '^WHITELIST=' "$STREAK_ENV" 2>/dev/null | cut -d= -f2- || true)
printf 'TOKEN=%s\nWHITELIST=%s\n' "$NEW_TOKEN" "${WHITELIST:-dengyie}" > "$STREAK_ENV.new"
chown root:streak "$STREAK_ENV.new"
chmod 640 "$STREAK_ENV.new"
mv "$STREAK_ENV.new" "$STREAK_ENV"

systemctl restart "$SERVICE"
sleep 2
code=$(curl -sS -o "$CHECK" -w '%{http_code}' \
  "http://127.0.0.1/index?username=dengyie&show_icons=true&t=$(date +%s)" || true)

systemctl restart "$STREAK_SERVICE"
sleep 2
code2=$(curl -sS -o "$CHECK2" -w '%{http_code}' \
  "http://127.0.0.1:8080/?user=dengyie&theme=tokyonight&hide_border=true&t=$(date +%s)" || true)

if [[ $code == 200 ]] && ! grep -q "Something went wrong" "$CHECK" \
   && [[ $code2 == 200 ]] && ! grep -q "Error lable" "$CHECK2"; then
  echo "rotate OK: grs card 200 + streak card 200 via new token"
  rm -f "$CHECK" "$CHECK2"
else
  echo "rotate FAILED: grs http=$code / streak http=$code2 (token not applied?); files kept at $TOKEN_FILE, $STREAK_ENV" >&2
  rm -f "$CHECK" "$CHECK2"
  exit 1
fi
