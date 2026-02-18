#!/usr/bin/env bash
set -e
cd /home/shamsu/.openclaw/workspace/conops-builder-v2
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
pip install -r requirements.txt

cd /home/shamsu/.openclaw/workspace/conops-builder-v2/web
npm install
cd /home/shamsu/.openclaw/workspace/conops-builder-v2

npx concurrently -k -n backend,frontend \
  "uvicorn app.main:app --reload --host 0.0.0.0 --port 5071" \
  "cd web && npm run dev -- --host 0.0.0.0 --port 5173"
