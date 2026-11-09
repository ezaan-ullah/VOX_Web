@echo off
rem Starts the M2D Music Dashboard on http://127.0.0.1:8000 and opens it in the browser.
rem First time only:  python -m venv .venv  &&  .venv\Scripts\pip install -r requirements.txt
rem                   .venv\Scripts\python backend\scripts\download_models.py
cd /d "%~dp0"
set PY=python
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
start "" "http://127.0.0.1:8000/#demo"
%PY% -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
