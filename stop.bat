@echo off
cd /d "%~dp0"
echo Encerrando o ccusage (painel ou headless)...
if exist server.pid (
  for /f %%p in (server.pid) do taskkill /F /PID %%p >nul 2>&1
  del /q server.pid >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8384 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Pronto.
timeout /t 2 >nul
