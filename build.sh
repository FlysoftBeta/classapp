#!/bin/sh
set -e

BUILD_ID="${CLASSAPP_BUILD_ID:-$(git rev-parse --short HEAD)}"
export CLASSAPP_BUILD_ID="$BUILD_ID"

rm -rf ./dist ./build
npm run infini2:build
npx vite build
npx vite build --config vite.server.config.ts
mkdir -p ./dist/server/pdfjs-dist/legacy/build
cp -r ./node_modules/pdfjs-dist/cmaps ./node_modules/pdfjs-dist/standard_fonts ./node_modules/pdfjs-dist/wasm ./dist/server/pdfjs-dist/
cp ./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs ./dist/server/pdfjs-dist/legacy/build/
npx vite build --config vite.bootstrap.config.ts
npx vite build --config vite.launcher.config.ts
printf '%s' "$BUILD_ID" > ./dist/build-id.txt

HTTPS_SOURCE="./scripts/secrets/https"
if [ -f "$HTTPS_SOURCE/config.json" ] &&
   [ -f "$HTTPS_SOURCE/fullchain.pem" ] &&
   [ -f "$HTTPS_SOURCE/privkey.pem" ] &&
   [ -f "$HTTPS_SOURCE/root.pem" ]; then
  mkdir -p ./dist/https
  cp "$HTTPS_SOURCE/config.json" "$HTTPS_SOURCE/fullchain.pem" \
    "$HTTPS_SOURCE/privkey.pem" "$HTTPS_SOURCE/root.pem" ./dist/https/
elif [ "${CLASSAPP_REQUIRE_HTTPS:-0}" = "1" ]; then
  echo "HTTPS deployment files are missing. Run: npm run https:renew" >&2
  exit 1
else
  echo "HTTPS deployment files not found; building without HTTPS credentials."
fi

DEPLOY="build/deploy"
DEPLOY_ZIP="build/deploy.zip"
BOOTSTRAP_ZIP="build/bootstrap.zip"

mkdir -p "$DEPLOY/current"
cp -r ./dist/client "$DEPLOY/current/client"
cp -r ./dist/server "$DEPLOY/current/server"
cp -r ./public "$DEPLOY/current/public"
cp ./shell.html ./dist/server.js ./dist/build-id.txt "$DEPLOY/current/"
if [ -d ./dist/https ]; then
  cp -r ./dist/https "$DEPLOY/current/https"
fi
node ./scripts/prepare-runtime-deps.mjs "$DEPLOY/current/node_modules"
cp ./launcher/start.sh ./launcher/start.bat ./dist/launcher.js "$DEPLOY/"

( cd "$DEPLOY/current" && zip -rq "../../deploy.zip" . )
( cd "$DEPLOY" && zip -rq "../bootstrap.zip" . )

echo "Bootstrap: $BOOTSTRAP_ZIP"
echo "Upload:    $DEPLOY_ZIP"
