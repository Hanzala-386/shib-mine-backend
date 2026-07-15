#!/usr/bin/env bash
# Build the self-contained VPS backend package: dist/shib-backend-vps.zip
# The bundle needs NO npm install on the VPS — all deps are baked into server.cjs.
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE=/tmp/vps-package
rm -rf "$STAGE"
mkdir -p "$STAGE/server" dist

npx esbuild shib-mine-backend/server/index.ts \
  --platform=node --bundle --format=cjs --external:pg-native \
  --outfile="$STAGE/server.cjs" --log-level=warning

cp shib-mine-backend/app.json "$STAGE/"
cp -r shib-mine-backend/server/templates "$STAGE/server/"
cp -r shib-mine-backend/public "$STAGE/public"
for f in .env.example shib-backend.service nginx-backend.webcod.in.conf DEPLOY.md; do
  cp "deploy/vps/$f" "$STAGE/" 2>/dev/null || true
done

(cd "$STAGE" && zip -qr /home/runner/workspace/dist/shib-backend-vps.zip .)
echo "Built dist/shib-backend-vps.zip ($(du -h dist/shib-backend-vps.zip | cut -f1))"
