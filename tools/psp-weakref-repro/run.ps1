# Build pspclosure against Unreal's own python311 and run the repro before and after the hotfix.
param(
    [string]$UeRoot = 'C:\Program Files\Epic Games\UE_5.8',
    [string]$VcVars = 'C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat',
    [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'hayba-psp-repro')
)
$py  = Join-Path $UeRoot 'Engine\Binaries\ThirdParty\Python3\Win64\python.exe'
$inc = Join-Path $UeRoot 'Engine\Source\ThirdParty\Python3\Win64\include'
$lib = Join-Path $UeRoot 'Engine\Source\ThirdParty\Python3\Win64\libs'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$src = Join-Path $PSScriptRoot 'pspclosure.c'
$bat = Join-Path $OutDir 'build.bat'
Set-Content -Encoding ascii $bat "@call `"$VcVars`" >nul`r`ncl /nologo /LD /O2 /I`"$inc`" `"$src`" /Fo`"$OutDir\pspclosure.obj`" /Fe`"$OutDir\pspclosure.pyd`" /link /LIBPATH:`"$lib`" >nul"
cmd /c $bat
if ($LASTEXITCODE -ne 0) { Write-Output 'build failed'; exit 2 }
$env:PYTHONPATH = $OutDir
$repro = Join-Path $PSScriptRoot 'repro.py'
Write-Output '--- without hotfix (expect a crash: exit -1073741819 = 0xC0000005)'
& $py $repro; $before = $LASTEXITCODE; Write-Output "exit=$before"
Write-Output '--- with hotfix (expect survived, exit=0)'
& $py $repro --fix; $after = $LASTEXITCODE; Write-Output "exit=$after"
if ($before -ne 0 -and $after -eq 0) { Write-Output 'REPRO OK: crashes without the hotfix, safe with it'; exit 0 }
Write-Output 'REPRO FAILED'; exit 1
