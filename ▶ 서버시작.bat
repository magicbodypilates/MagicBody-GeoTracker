@echo off
cd /d "%~dp0"

if exist ".env.local" (
  copy /Y ".env.local" ".next\standalone\.env.local" >nul
)

if not exist ".next\standalone\public" (
  xcopy /E /I /Y /Q "public" ".next\standalone\public" >nul
)
if not exist ".next\standalone\.next\static" (
  xcopy /E /I /Y /Q ".next\static" ".next\standalone\.next\static" >nul
)

set PORT=3000
set HOSTNAME=0.0.0.0
set NEXT_TELEMETRY_DISABLED=1

echo.
echo Starting GeoTracker server...
echo Browser: http://localhost:3000/geo-tracker
echo.
node .next\standalone\server.js
pause
