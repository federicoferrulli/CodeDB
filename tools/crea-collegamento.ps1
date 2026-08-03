# Crea i collegamenti per avviare CodeDB DAI SORGENTI (server + browser) sul
# Desktop e nel menu Start, con l'icona del progetto.
#
# Il target è cmd.exe /c "...\CodeDB.cmd" (non il .cmd direttamente): Windows
# consente di aggiungere alla barra delle applicazioni solo collegamenti a
# eseguibili, quindi così il collegamento diventa "pinnabile" (tasto destro →
# Aggiungi alla barra delle applicazioni, o trascinandolo sulla barra).
#
# NOME DEL COLLEGAMENTO — "CodeDB (sorgenti)", non "CodeDB".
# L'installer NSIS crea i propri collegamenti chiamati esattamente "CodeDB", che
# avviano l'APP DESKTOP (Electron). Con lo stesso nome e la stessa icona i due
# diventano indistinguibili: si clicca quello sbagliato e si apre il browser
# invece della finestra dell'applicazione, senza alcun indizio del perché.
# Questo script serve a chi lavora sul repository, quindi è il suo collegamento
# a doversi qualificare.
#
# Uso: npm run shortcut (oppure esegui questo file direttamente).
$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root 'CodeDB.cmd'
$ws = New-Object -ComObject WScript.Shell

$nome = 'CodeDB (sorgenti).lnk'
$destinazioni = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) $nome),
  (Join-Path ([Environment]::GetFolderPath('Programs')) $nome)  # menu Start
)
foreach ($dest in $destinazioni) {
  $lnk = $ws.CreateShortcut($dest)
  $lnk.TargetPath = $env:ComSpec
  $lnk.Arguments = "/c `"$cmd`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $root 'public\codedb.ico') + ',0'
  $lnk.Description = 'CodeDB dai sorgenti: avvia il server e apre il browser (non l''app desktop)'
  $lnk.Save()
  Write-Host "Collegamento creato: $dest"
}

# Collegamenti "CodeDB" creati dalle versioni precedenti di questo script: hanno
# lo stesso nome di quelli dell'installer e sono la causa dell'ambiguità sopra.
# Non si cancellano d'ufficio (potrebbero essere quelli dell'app installata):
# si segnalano, dicendo come distinguerli.
$vecchi = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodeDB.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'CodeDB.lnk')
) | Where-Object { Test-Path $_ }

foreach ($v in $vecchi) {
  $t = $ws.CreateShortcut($v).TargetPath
  if ($t -like '*cmd.exe' -or $t -like '*CodeDB.cmd') {
    Write-Host "ATTENZIONE: esiste ancora il vecchio collegamento '$v', che apre il BROWSER. Ora e' duplicato da quello appena creato: puoi eliminarlo."
  } else {
    Write-Host "Nota: '$v' punta a '$t' (app desktop installata): lasciato invariato."
  }
}

Write-Host "Per la barra delle applicazioni: tasto destro sul collegamento -> 'Aggiungi alla barra delle applicazioni' (su Windows 11 sotto 'Mostra altre opzioni'), oppure trascinalo sulla barra. Dal menu Start puoi anche 'Aggiungi a Start'."
