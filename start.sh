#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "[erro] Node.js nao encontrado."; exit 1; }
nohup node server.js > /dev/null 2>&1 &
echo $! > server.pid
sleep 1
(xdg-open http://localhost:8384 || open http://localhost:8384) >/dev/null 2>&1
echo "Painel em segundo plano (PID $(cat server.pid)). Use ./stop.sh para encerrar."
