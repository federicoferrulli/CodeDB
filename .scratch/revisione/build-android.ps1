$ErrorActionPreference = 'Continue'
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:ANDROID_HOME = 'C:\repository\CodeDB\android\.cache\sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = 'C:\repository\CodeDB\android\.cache\android-user'
$env:GRADLE_USER_HOME = 'C:\repository\CodeDB\android\.cache\gradle-user'
# Indice privato per il packaging dei nuovi sorgenti; lo staging dell'utente resta intatto.
$env:GIT_INDEX_FILE = 'C:\repository\CodeDB\.scratch\revisione\index'
git add -- public/js/document-switcher.js public/js/pane-runtime.js public/js/query-document.js public/js/table-resize.js ui/navigation-sheet.tsx ui/components/arc/bottom-sheet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node android/prepare.cjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Remove-Item Env:GIT_INDEX_FILE
& 'C:\repository\CodeDB\android\.cache\gradle-8.11.1\bin\gradle.bat' -p android assembleDebug connectedDebugAndroidTest
exit $LASTEXITCODE
