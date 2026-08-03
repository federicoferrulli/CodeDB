#!/usr/bin/env bash
# Crea l'avvio rapido di CodeDB DAI SORGENTI (server + browser) su Linux/macOS.
# Non è l'app desktop: quella la installano i pacchetti .deb/AppImage.
# - Linux: voce "CodeDB (sorgenti)" nel menu applicazioni (~/.local/share/applications):
#   da lì la puoi aggiungere ai preferiti/dock (tasto destro → Aggiungi ai
#   preferiti su GNOME, o equivalente KDE). Terminal=true perché il server
#   chiede la passphrase dei segreti all'avvio.
# - macOS: non esiste un formato .desktop; lo script stampa le istruzioni per
#   il Dock (o per creare un'app con Automator).
# Uso: npm run shortcut-unix (oppure bash tools/crea-collegamento.sh)
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$root/codedb.sh"

if [ "$(uname)" = "Darwin" ]; then
  echo "macOS: due opzioni per l'avvio rapido di CodeDB:"
  echo "  1. Dock: trascina $root/codedb.sh nella parte destra del Dock (vicino al Cestino)."
  echo "  2. App vera e propria: Automator → Nuova Applicazione → azione 'Esegui script shell'"
  echo "     con: \"$root/codedb.sh\" — salvala come CodeDB.app e trascinala nel Dock."
  exit 0
fi

# Nome del file e della voce: "codedb-sorgenti", NON "codedb".
# I pacchetti .deb/AppImage installano `codedb.desktop` (vedi `desktopName` in
# package.json). Una voce omonima in ~/.local/share/applications ha la
# PRECEDENZA su quella di sistema: scriverla qui non affiancherebbe l'app
# installata, la nasconderebbe — e dal menu si aprirebbe il browser invece
# della finestra dell'applicazione, senza alcun indizio del perché.
dest="$HOME/.local/share/applications/codedb-sorgenti.desktop"
mkdir -p "$(dirname "$dest")"
cat > "$dest" <<EOF
[Desktop Entry]
Type=Application
Name=CodeDB (sorgenti)
Comment=CodeDB dai sorgenti: avvia il server e apre il browser (non l'app desktop)
Exec=$root/codedb.sh
Path=$root
Icon=$root/public/codedb.png
Terminal=true
Categories=Development;Database;
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$dest")" || true
echo "Voce 'CodeDB (sorgenti)' creata nel menu applicazioni ($dest)."
# Voce omonima all'app installata, creata dalle versioni precedenti di questo
# script: la si segnala invece di cancellarla d'ufficio.
if [ -f "$HOME/.local/share/applications/codedb.desktop" ]; then
  echo "ATTENZIONE: esiste ancora ~/.local/share/applications/codedb.desktop, creato da una versione precedente di questo script."
  echo "            Ha lo stesso nome della voce installata dal pacchetto .deb/AppImage e la nasconde: puoi eliminarlo."
fi
echo "Per i preferiti/dock: cerca CodeDB nel menu → tasto destro → 'Aggiungi ai preferiti' (GNOME) o 'Aggiungi al pannello' (KDE)."
