param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Editor, [int]$Port=39787)
$ErrorActionPreference='Stop'
$projectFile=(Resolve-Path -LiteralPath $Project).Path
if([IO.Path]::GetFileName($projectFile) -ne 'LightingAcceptance.uproject'){throw 'Use the disposable LightingAcceptance test project'}
$root=Split-Path $projectFile
$fixture=Join-Path $root 'Plugins/LightingFixture/LightingFixture.uplugin'
if(!(Test-Path -LiteralPath $fixture)){throw 'Expected the disposable project fixture'}
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'Test port already in use'}
$script=(Resolve-Path -LiteralPath (Join-Path $root 'Plugins/HaybaMCPToolkit/Resources/chat/chat.js')).Path
if(!$script.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected fixture path'}
$original=[IO.File]::ReadAllBytes($script)
$originalHash=(Get-FileHash -LiteralPath $script).Hash
$process=$null
try {
    $source=[Text.Encoding]::UTF8.GetString($original)
    [IO.File]::WriteAllText($script,"setTimeout(() => {" + [Environment]::NewLine + $source + [Environment]::NewLine + "window.haybaDelayedChatReadyAt=performance.now(); }, 12000);")
    $process=Start-Process $Editor -WindowStyle Hidden -PassThru -ArgumentList @(('"'+$projectFile+'"'),'-NoSplash','-NoSound','-Unattended','-RenderOffscreen','-HaybaLightingFixture',("-cefdebug="+$Port),'-ExecCmds="Hayba.MCP.Open"')
    $ready=$false
    for($i=0;$i -lt 120 -and !$process.HasExited;$i++){
        try {
            $targets=Invoke-RestMethod ("http://127.0.0.1:"+$Port+"/json/list") -TimeoutSec 2
            if($targets.url -match 'Resources/chat/index.html'){$ready=$true;break}
        }catch{}
        Start-Sleep -Seconds 1
    }
    if(!$ready){throw 'The editor did not open the fixture chat'}
    node "$PSScriptRoot/test-editor.cjs" $projectFile $Port --delayed
    if($LASTEXITCODE -ne 0){throw 'The delayed installed chat did not recover'}
}finally{
    if($process -and !$process.HasExited){
        if(!$process.CloseMainWindow() -or !$process.WaitForExit(10000)){Stop-Process -Id $process.Id}
    }
    [IO.File]::WriteAllBytes($script,$original)
    if((Get-FileHash -LiteralPath $script).Hash -ne $originalHash){throw 'Chat fixture restoration failed'}
}
