@echo off
rem Double-click to start the MESA Archive app and open it in your browser.
rem Close this window to stop the app.
cd /d "%~dp0"
if not exist ".next\BUILD_ID" (
  echo First run: building the app, this takes about a minute...
  call npm run build || (echo Build failed. & pause & exit /b 1)
)
start "" http://localhost:3000
call npm run start
pause
