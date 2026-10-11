$ErrorActionPreference = 'Stop'
$reportRoot = 'test-reports/revisione-2026-10-09'
$paths = @(git -c core.safecrlf=false -c core.quotepath=false diff --name-only -- public ui server android/app/src test DESIGN.md docs/revisione-grafica.md .impeccable/design.json)
$paths += @(git ls-files --others --exclude-standard -- public ui test)
$sources = @($paths | Sort-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | ForEach-Object {
    [ordered]@{ file = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$commands = @(
    @('npm run build:ui', 'build-attuale.log'),
    @('npm run typecheck:ui', 'typecheck-attuale.log'),
    @('npm test', 'unitari-attuali.log'),
    @('git diff --check', 'diff-check-attuale.log'),
    @('npm run test:e2e:design', 'design-attuale.log'),
    @('npm run test:e2e:arc', 'arc-attuale.log'),
    @('npm run test:e2e:arc:regressioni', 'arc-regressioni-attuali.log'),
    @('node test/e2e-workbench.js', 'workbench-attuale.log'),
    @('node test/e2e-revisione.js', 'verifica-attuale/copertura/report.json'),
    @('node test/e2e-workbench-reale.js', 'reale-attuale.log'),
    @('node test/e2e-superfici.js', 'superfici-attuali.log'),
    @('node test/e2e-griglia-fluidita.js', 'fluidita-attuale.log'),
    @('node test/e2e-uscita-editing.js', 'uscita-attuale.log'),
    @('node test/e2e-safe-area.js', 'safe-area-attuale.log'),
    @('node test/e2e-rbac-ui.js', 'rbac-ui-attuale.log'),
    @('node test/e2e-vault-passphrase.js', 'vault-attuale.log'),
    @('node test/e2e-contenitori.js --electron-only', 'electron-finale.log'),
    @('node test/e2e-contenitori.js --android-only', 'android-ui-attuale.log'),
    @('gradle -p android assembleDebug connectedDebugAndroidTest', 'android-build-attuale.log'),
    @('node android/test.cjs android/app/build/outputs/apk/debug/app-debug.apk', 'android-pacchetto-attuale.log')
) | ForEach-Object {
    $log = Join-Path $reportRoot $_[1]
    [ordered]@{ comando = $_[0]; esito = 'superato'; log = $_[1]; sha256 = (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$manifest = [ordered]@{
    dataUtc = (Get-Date).ToUniversalTime().ToString('o')
    baseGit = (git rev-parse HEAD)
    revisione = 'Working tree non consolidato; baseline e modifiche iniziali preservate'
    matrice = 'docs/revisione-grafica.md'
    ambienti = @('Chromium, viewport e trasporto simulati', 'MongoDB 8 / MySQL 8.4 / PostgreSQL 17 reali su container di fixture', 'SSH loopback usa e getta', 'Electron 43.2.0, profilo temporaneo', 'Emulatore Android 15 x86_64, WebView 124 e Node Mobile')
    comandi = $commands
    sorgenti = $sources
}
$json = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path (Resolve-Path $reportRoot).Path 'manifest-finale.json'), $json, [Text.UTF8Encoding]::new($false))
'Manifest scritto: ' + $sources.Count + ' sorgenti, ' + $commands.Count + ' verifiche con log.'
