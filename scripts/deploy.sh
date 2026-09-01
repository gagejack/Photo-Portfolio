#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="/opt/photoportfolio"
readonly BRANCH="main"
readonly SERVICE="photoportfolio"

trap 'echo "Deployment failed on line $LINENO." >&2' ERR

cd "$APP_DIR"

echo "Pulling origin/$BRANCH..."
git pull --ff-only origin "$BRANCH"

echo "Installing dependencies..."
npm ci --include=dev

echo "Building frontend..."
npm run build

echo "Pruning development dependencies..."
npm prune --omit=dev --no-save --package-lock=false

echo "Restarting $SERVICE..."
sudo systemctl restart "$SERVICE"

if ! sudo systemctl is-active --quiet "$SERVICE"; then
  sudo systemctl --no-pager --full status "$SERVICE"
  exit 1
fi

echo "Deployment complete: $(git rev-parse --short HEAD)"
