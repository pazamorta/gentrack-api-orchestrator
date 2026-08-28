@echo off
REM Start the API Orchestrator dev server
REM Double-click this file or run it from a terminal to start the service

echo Starting API Orchestrator...
cd /d "%~dp0"

REM Accept self-signed certs on backend HTTPS calls
set NODE_TLS_REJECT_UNAUTHORIZED=0

REM Install dependencies if node_modules is missing
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

npm run dev

REM Keep window open if the server exits or errors
pause
