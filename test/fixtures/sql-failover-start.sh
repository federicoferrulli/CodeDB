#!/bin/bash
set -euo pipefail
# Tre processi reali e tre directory isolate, raggiungibili anche dal runner host.
ports=(27039 27040 27041)
if [[ "${1:-}" == stop || "${1:-}" == start ]]; then
  [[ "${2:-}" =~ ^270(39|40|41)$ ]] || exit 2
  if [[ "$1" == stop ]]; then
    kill -9 "$(cat "/data/sql-$2.pid")"
    exit
  fi
  ports=("$2")
fi
for port in "${ports[@]}"; do
  mkdir -p "/data/sql-$port"
  mongod --replSet codedbtest --bind_ip_all --port "$port" --dbpath "/data/sql-$port" --logpath "/data/sql-$port.log" --pidfilepath "/data/sql-$port.pid" --fork --oplogSize 128
done
if [[ "${1:-}" == start ]]; then exit; fi
exec tail -f /dev/null
