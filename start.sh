#!/bin/sh
# Starts the M2D Music Dashboard on http://127.0.0.1:8000.
# First time only:  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
#                   .venv/bin/python backend/scripts/download_models.py
# For a recording take, open http://127.0.0.1:8000/?record&speed=0.8#demo (R resets, speed slows the animation).
cd "$(dirname "$0")" || exit 1
PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
exec "$PY" -m uvicorn backend.app:app --host 127.0.0.1 --port "${PORT:-8000}"
