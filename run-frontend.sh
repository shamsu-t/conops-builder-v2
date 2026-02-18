#!/usr/bin/env bash
set -e
cd /home/shamsu/.openclaw/workspace/conops-builder-v2/web
npm install
npm run dev -- --host 0.0.0.0 --port 5173
