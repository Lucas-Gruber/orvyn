#!/usr/bin/env bash
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p .local
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker info >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Docker did not become ready. Rebuild the Codespaces container and inspect its creation log.' >&2
  exit 1
fi
if curl --fail --silent --max-time 2 http://127.0.0.1:5000/api/v1/health >/dev/null 2>&1; then
  echo 'Orvyn is already running. Open port 5000 in the Ports tab.'
  exit 0
fi
nohup pnpm preview:local > .local/codespaces-preview.log 2>&1 </dev/null &
echo "$!" > .local/codespaces-preview.pid
echo 'Orvyn preparation is running. The browser opens when port 5000 is ready.'
echo 'If startup fails, inspect .local/codespaces-preview.log in the Codespaces terminal.'
