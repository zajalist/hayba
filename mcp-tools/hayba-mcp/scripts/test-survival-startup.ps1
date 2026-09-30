param([Parameter(Mandatory=$true)][string]$HarnessPath)
$ErrorActionPreference = 'Stop'
$errors=$null; $tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($HarnessPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Survival harness did not parse'}
$results=[Collections.Generic.List[object]]::new()

# Evaluate the actual catalog assignment, without executing any Python.
$Port=52349
$catalog=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$fatalCases'},$true))
if($catalog.Count -ne 1){throw 'Expected one fatal case catalog'}
. ([scriptblock]::Create($catalog[0].Extent.Text))
$payload=($fatalCases|Where-Object Name -CEQ 'self_socket_deadlock').Script
$results.Add([pscustomobject]@{name='owned_nondefault_self_socket';passed=$payload -ceq 'import socket; s=socket.socket(); s.connect(("127.0.0.1",52349))'})

foreach($name in @('Get-SanitizedHash','Resolve-FullPath','Test-ExactCommandLineArgument','New-EditorIdentity','Assert-EditorIdentity','Find-OwnedMcpPort','Get-ListenerOwner','Get-RemainingCaseMs','Invoke-HaybaCommand','Get-RemainingStartupMs','Wait-EditorReady')){
    $definitions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($definitions.Count -ne 1){
        $results.Add([pscustomobject]@{name='shared_startup_readiness';passed=$false;reason="Missing helper: $name"})
        $results|ConvertTo-Json -Compress
        exit 1
    }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
# Only OS/process/listener/time/transport boundaries are doubled. The source
# owns identity comparison, port selection, deadline accounting and admission.
function Get-EditorProcessRow {
    param([int]$ProcessId)
    $StartupClock.ElapsedMilliseconds+=20
    if($Scenario -ceq 'process_death' -and $Requests.Count){throw 'editor PID does not exist'}
    $created=[datetime]'2026-01-01T00:00:00Z'
    if($Scenario -ceq 'identity_replaced' -and $Requests.Count){$created=$created.AddSeconds(1)}
    $exe=$EditorExe
    if($Scenario -ceq 'wrong_initial_identity'){$exe='C:/fake/Other.exe'}
    [pscustomobject]@{ExecutablePath=$exe;CreationDate=$created;CommandLine="`"$ProjectPath`" -HaybaSurvivalSession=$SessionToken"}
}
function Get-NetTCPConnection {
    param($OwningProcess,$LocalPort,$State,$ErrorAction)
    $StartupClock.ElapsedMilliseconds+=20
    if($Scenario -ceq 'listener_late' -and $StartupClock.ElapsedMilliseconds -lt 35000){return}
    $owner=42
    if($Scenario -in @('listener_replaced','explicit_foreign_port') -and ($Requests.Count -or $Scenario -ceq 'explicit_foreign_port')){$owner=99}
    [pscustomobject]@{LocalPort=52349;OwningProcess=$owner}
}
function Start-Sleep { param([int]$Milliseconds) $StartupClock.ElapsedMilliseconds+=$Milliseconds }
$Invoker={
    param($Cmd,$ParamsJson,$Port,$TimeoutMs,$Auth,[switch]$ThrowOnTimeout)
    $Requests.Add([pscustomobject]@{command=$Cmd;timeout=$TimeoutMs;port=$Port;elapsed=$StartupClock.ElapsedMilliseconds})
    $global:LASTEXITCODE=0
    if($Cmd -cne 'ping' -or $Port -ne 52349){throw 'Unexpected startup command or port'}
    if($CaseDeadline -ne $null){return '{"id":"probe_case","ok":true}'}
    if($Scenario -ceq 'transport_failure'){$global:LASTEXITCODE=1;return}
    if($Scenario -in @('early_listener','exhausted','process_death','identity_replaced','listener_replaced') -and ($Requests.Count -eq 1 -or $Scenario -ceq 'exhausted')){
        $StartupClock.ElapsedMilliseconds+=$TimeoutMs
        if(-not $ThrowOnTimeout){throw 'Startup did not request structured timeout distinction'}
        throw [TimeoutException]::new('controlled transport deadline')
    }
    $StartupClock.ElapsedMilliseconds+=100
    if($Scenario -ceq 'late_response'){$StartupClock.ElapsedMilliseconds=$StartupTimeoutMs}
    switch($Scenario){
        'refused' {return '{"id":"probe_ready","ok":false}'}
        'malformed_ok' {return '{"id":"probe_ready","ok":"true"}'}
        'malformed_json' {return '{'}
        default {return '{"id":"probe_ready","ok":true,"data":{"transport_limits":{"applies":"active_tcp_server_snapshot"}}}'}
    }
}
$EditorPid=42; $EditorExe='C:/fake/UnrealEditor.exe'; $ProjectPath='C:/fake/Scratch.uproject'; $SessionToken='disposable_test_token'; $Auth=''
$MaxCaseMs=500
$cases=@(
    @{name='early_listener'},@{name='listener_late'},@{name='explicit_attach'},
    @{name='exhausted';error='startup deadline'},@{name='setup_exhausted';error='startup deadline'},
    @{name='process_death';error='does not exist'},@{name='identity_replaced';error='identity changed'},
    @{name='wrong_initial_identity';error='executable mismatch'},
    @{name='listener_replaced';error='listener'},@{name='explicit_foreign_port';error='listener'},
    @{name='refused';error='readiness ping'},@{name='malformed_ok';error='readiness ping'},
    @{name='malformed_json';error='JSON'},@{name='transport_failure';error='transport failed'},
    @{name='late_response';error='startup deadline'}
)
foreach($case in $cases){
    $Scenario=$case.name; $StartupTimeoutMs=140000
    $StartupClock=[pscustomobject]@{ElapsedMilliseconds=30000}
    if($Scenario -ceq 'setup_exhausted'){$StartupClock.ElapsedMilliseconds=140000}
    $StartupReadinessEvidence=$null; $EditorIdentity=$null; $CaseDeadline=$null
    $Port=if($Scenario -in @('explicit_attach','explicit_foreign_port')){52349}else{0}
    $Requests=[Collections.Generic.List[object]]::new()
    $passed=$false; $reason=''
    try{
        $reply=Wait-EditorReady
        if($case.ContainsKey('error')){throw 'Expected rejection was admitted'}
        if($reply.data.transport_limits.applies -cne 'active_tcp_server_snapshot'){throw 'Readiness reply was not retained'}
        if($StartupReadinessEvidence.ready -ne $true -or $StartupReadinessEvidence.request_id_correlated -ne $true){throw 'Readiness proof absent'}
        if($Scenario -ceq 'early_listener' -and ($Requests.Count -ne 2 -or $Requests[0].timeout -ne 60000 -or $Requests[1].timeout -ge 50000)){throw 'Startup budget was reset or readiness did not retry'}
        if($Scenario -ceq 'listener_late' -and $Requests[0].elapsed -lt 35000){throw 'Command sent before owned discovery'}
        foreach($request in $Requests){if($request.timeout -lt 100 -or $request.timeout -gt 60000 -or ($request.elapsed+$request.timeout) -gt 140000){throw 'Unbounded startup request'}}
        $CaseDeadline=[DateTime]::UtcNow.AddMilliseconds(500)
        Invoke-HaybaCommand -Command 'ping'|Out-Null
        if($Requests[-1].timeout -gt 500){throw 'Startup allowance leaked into hostile case'}
        $requestCount=$Requests.Count
        $CaseDeadline=[DateTime]::UtcNow.AddMilliseconds(-1)
        try { Invoke-HaybaCommand -Command 'ping'|Out-Null; throw 'Expired hostile case was admitted' }
        catch { if($_.Exception.Message -notmatch 'absolute 500ms case deadline'){throw} }
        if($Requests.Count -ne $requestCount){throw 'Expired hostile case sent another command'}
        $passed=$true
    }catch{
        $reason=$_.Exception.Message
        $passed=$case.ContainsKey('error') -and $reason -match $case.error
        if($StartupReadinessEvidence.ready -eq $true){$passed=$false}
    }
    if($Scenario -ceq 'exhausted' -and ($Requests.Count -ne 2 -or $StartupClock.ElapsedMilliseconds -gt 140100)){$passed=$false}
    if($Scenario -ceq 'setup_exhausted' -and $null -eq $EditorIdentity){$passed=$false;$reason='Startup expiry lost identity needed by owned cleanup'}
    if($Scenario -in @('process_death','identity_replaced','listener_replaced','refused','malformed_ok','malformed_json','transport_failure','late_response') -and $Requests.Count -ne 1){$passed=$false}
    if($Scenario -in @('setup_exhausted','wrong_initial_identity','explicit_foreign_port') -and $Requests.Count -ne 0){$passed=$false}
    $results.Add([pscustomobject]@{name=$Scenario;passed=$passed;reason=$(if($passed){''}else{$reason})})
}
$results|ConvertTo-Json -Compress
if(@($results|Where-Object{-not $_.passed}).Count){exit 1}
exit 0
