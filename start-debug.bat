@echo off
title ccusage dashboard (debug)
cd /d "%~dp0"
where node >nul 2>nul || (echo [erro] Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8384
node server.js
pause
