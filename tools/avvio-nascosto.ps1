# Avvia o riusa il server del profilo corrente e apre il browser.
param([switch]$NoBrowser)
node (Join-Path $PSScriptRoot 'lanciatore.js') start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$port = if ($env:PORT) { [int]$env:PORT } else { 3030 }
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port" }
exit 0
