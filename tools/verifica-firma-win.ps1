param([string]$Directory = 'dist')
$ErrorActionPreference = 'Stop'
if (-not $env:AZURE_PUBLISHER_NAME) { throw 'Configura AZURE_PUBLISHER_NAME per verificare il firmatario atteso.' }
$files = @(Get-ChildItem -LiteralPath $Directory -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' })
if ($files.Count -eq 0) { throw 'Nessun eseguibile da verificare.' }
foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid') { throw "Firma Authenticode non valida: $($file.Name)" }
    if (-not $signature.TimeStamperCertificate) { throw "Timestamp assente: $($file.Name)" }
    if ($signature.SignerCertificate.GetNameInfo('SimpleName', $false) -cne $env:AZURE_PUBLISHER_NAME) {
        throw "Firmatario diverso da AZURE_PUBLISHER_NAME: $($file.Name)"
    }
}
Write-Output "Verificate $($files.Count) firme Authenticode, editore e timestamp."
