#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -f server.pid ] && kill "$(cat server.pid)" 2>/dev/null && rm -f server.pid && echo "Painel encerrado." || echo "Nenhum painel rodando."
