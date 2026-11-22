#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if [ "${1:-}" = stop ]; then exec node tools/lanciatore.js stop; fi
node tools/lanciatore.js status
case $? in
  0) ;;
  2) if [ -z "${GUI_MONGO_PASSPHRASE:-}" ] && [ -t 0 ]; then
       read -r -s -p "Inserisci la passphrase dei segreti di CodeDB: " GUI_MONGO_PASSPHRASE
       echo
       export GUI_MONGO_PASSPHRASE
     fi ;;
  *) exit 1 ;;
esac
node tools/lanciatore.js start || exit 1
url="http://127.0.0.1:${PORT:-3030}"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then open "$url"
else echo "Apri manualmente $url"; fi
