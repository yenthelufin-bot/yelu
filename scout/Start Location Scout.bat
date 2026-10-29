@echo off
rem Dubbelklik om Location Scout te starten (Windows).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is niet gevonden. Installeer de LTS-versie van https://nodejs.org en probeer opnieuw.
  pause
  exit /b 1
)
node setup.mjs --check-node
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist node_modules (
  echo Eerste keer: onderdelen installeren...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo Installeren mislukt.
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:4173"
echo Location Scout start. Laat dit venster open zolang je de app gebruikt.
call npm.cmd start
pause
