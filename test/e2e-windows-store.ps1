param([switch]$Installa)
$ErrorActionPreference = 'Stop'
$pacchetti = @(Get-ChildItem -Path "$PSScriptRoot/../dist/store/*.appx")
if ($pacchetti.Count -ne 1) { throw 'Atteso un solo AppX in dist/store: elimina i vecchi pacchetti prima del collaudo.' }
$radice = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temp = Join-Path $radice ('codedb-appx-' + [guid]::NewGuid())
$estratti = Join-Path $temp 'estratti'
$certificato = $null
$fidato = $null
$installato = $null
$processoApp = 0
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($pacchetti[0].FullName, $estratti)
    [xml]$manifest = Get-Content -Raw -LiteralPath (Join-Path $estratti 'AppxManifest.xml')
    $atteso = node -e 'console.log(JSON.stringify(require(process.argv[1]).identita()))' "$PSScriptRoot/../tools/store.cjs" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Identità Store non valida' }
    if ($manifest.Package.Identity.Name -ne $atteso.identityName -or $manifest.Package.Identity.Publisher -ne $atteso.publisher -or $manifest.Package.Identity.Version -ne $atteso.version) { throw 'Identità/versione AppX diversa dalla configurazione' }
    $nome = if ($atteso.prova) { 'CodeDB - prova Store' } else { 'CodeDB Manager' }
    if ($manifest.Package.Properties.DisplayName -ne $nome -or $manifest.Package.Applications.Application.VisualElements.DisplayName -ne $nome) { throw 'Nome AppX diverso dal nome riservato nello Store' }
    if ($manifest.Package.Properties.PublisherDisplayName -ne $atteso.publisherDisplayName) { throw 'Nome editore AppX diverso dalla configurazione' }
    if ($manifest.Package.Applications.Application.EntryPoint -ne 'Windows.FullTrustApplication') { throw 'Runtime full trust mancante' }
    if (Test-Path (Join-Path $estratti 'app/resources/app-update.yml')) { throw 'Un feed NSIS è finito nel pacchetto Store' }
    foreach ($voce in @(@('StoreLogo',50,50), @('Square44x44Logo',44,44), @('Square150x150Logo',150,150), @('Wide310x150Logo',310,150))) {
        $bytes = [IO.File]::ReadAllBytes((Join-Path $estratti "assets/$($voce[0]).png"))
        $w = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes,16))
        $h = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($bytes,20))
        if ($w -ne $voce[1] -or $h -ne $voce[2]) { throw "Dimensioni icona $($voce[0]) errate" }
    }
    if (!$Installa) {
        node "$PSScriptRoot/e2e-release-desktop.cjs" (Join-Path $estratti 'app/CodeDB.exe')
        if ($LASTEXITCODE -ne 0) { throw 'Avvio del contenuto AppX fallito' }
        Write-Output 'OK manifest, icone, runtime e moduli nativi dal contenuto AppX. Identità installata verificata separatamente con -Installa.'
        return
    }
    if ($atteso.identityName -ne 'CodeDB.ProvaStore') { throw "Il test di installazione richiede build:store:test, mai l'identità di produzione." }
    if (Get-AppxPackage -Name $atteso.identityName) { throw 'Esiste già un pacchetto di prova: non verrà sostituito.' }
    $signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
    if (!$signtool) { throw 'Installa Windows SDK (SignTool) per il test AppX.' }
    $certificato = New-SelfSignedCertificate -Type Custom -Subject $atteso.publisher -KeyUsage DigitalSignature -FriendlyName 'CodeDB collaudo temporaneo' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
    $pubblico = Join-Path $temp 'collaudo.cer'
    Export-Certificate -Cert $certificato -FilePath $pubblico | Out-Null
    $fidato = Import-Certificate -FilePath $pubblico -CertStoreLocation Cert:\LocalMachine\TrustedPeople
    $copia = Join-Path $temp 'collaudo.appx'
    Copy-Item -LiteralPath $pacchetti[0].FullName -Destination $copia
    & $signtool.FullName sign /fd SHA256 /sha1 $certificato.Thumbprint $copia
    if ($LASTEXITCODE -ne 0) { throw 'Firma temporanea fallita' }
    Add-AppxPackage -Path $copia
    $installato = Get-AppxPackage -Name $atteso.identityName
    if (!$installato) { throw 'Pacchetto non installato' }
    # L'attivazione nativa assegna davvero l'identità AppX al processo.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodeDBActivate {
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class Manager {}
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, uint options, out uint pid);
  }
  public static uint Start(string id, string args) {
    uint pid; int hr = ((IManager)new Manager()).ActivateApplication(id, args, 0, out pid);
    Marshal.ThrowExceptionForHR(hr); return pid;
  }
}
'@
    $porta = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $porta.Start(); $numeroPorta = $porta.LocalEndpoint.Port; $porta.Stop()
    $processoApp = [CodeDBActivate]::Start("$($installato.PackageFamilyName)!CodeDB", "--inspect=127.0.0.1:$numeroPorta")
    node "$PSScriptRoot/store-runtime.cjs" $numeroPorta
    if ($LASTEXITCODE -ne 0) { throw 'Collaudo runtime AppX fallito' }
} finally {
    if ($processoApp) { Stop-Process -Id $processoApp -Force -ErrorAction SilentlyContinue }
    if ($installato) { Remove-AppxPackage -Package $installato.PackageFullName }
    if ($fidato) { Remove-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$($fidato.Thumbprint)" }
    if ($certificato) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificato.Thumbprint)" }
    $risolto = [IO.Path]::GetFullPath($temp)
    if (!$risolto.StartsWith($radice, [StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $risolto -Leaf).StartsWith('codedb-appx-')) { throw 'Directory temporanea inattesa: pulizia rifiutata.' }
    Remove-Item -LiteralPath $risolto -Recurse -Force
}
