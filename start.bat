@echo off
title ccusage dashboard
cd /d "%~dp0"

where node >nul 2>nul || (echo [erro] Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)

REM Instala o ccusage localmente (sem as devDependencies pesadas do Electron).
REM Com ele em node_modules, o painel usa o CLI local (rapido) em vez de baixar
REM via npx a cada consulta. So instala se ainda nao existir.
if not exist "node_modules\ccusage" (
  echo Instalando o ccusage ^(primeira vez; precisa de internet, pode demorar um pouco^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [aviso] npm install falhou; tentando preparar via npx...
    call npx -y ccusage@latest --version >nul 2>nul
    if errorlevel 1 (
      echo [aviso] Nao foi possivel preparar o ccusage. Confira internet / proxy da empresa.
      echo         O painel abre mesmo assim, mas pode nao mostrar dados.
      echo.
      pause
    )
  )
) else (
  echo ccusage ja instalado.
)

start "" http://localhost:8384
node server.js
pause
