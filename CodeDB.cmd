@echo off
setlocal
cd /d "%~dp0"
if /i "%~1"=="stop" goto :stop
powershell -NoProfile -ExecutionPolicy Bypass -File tools\avvio-nascosto.ps1
exit /b %errorlevel%
:stop
node tools\lanciatore.js stop
exit /b %errorlevel%
