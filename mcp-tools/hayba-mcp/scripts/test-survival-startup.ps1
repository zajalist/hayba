param([Parameter(Mandatory=$true)][string]$HarnessPath,[switch]$IdentityOnly)
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

foreach($name in @('Get-SanitizedHash','Resolve-FullPath','Test-ExactCommandLineArgument','Get-EditorProcessRow','New-EditorIdentity','Assert-EditorIdentity','Find-OwnedMcpPort','Get-ListenerOwner','Get-RemainingCaseMs','Invoke-HaybaCommand','Get-RemainingStartupMs','Wait-EditorReady')){
    $definitions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($definitions.Count -ne 1){
        $results.Add([pscustomobject]@{name='shared_startup_readiness';passed=$false;reason="Missing helper: $name"})
        $results|ConvertTo-Json -Compress
        exit 1
    }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$helperErrors=$null; $helperTokens=$null
$helperAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path -Parent $HarnessPath) 'query-survival-host-proof.ps1'),[ref]$helperTokens,[ref]$helperErrors)
if($helperErrors.Count){throw 'Host proof helper did not parse'}
$conversion=@($helperAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'ConvertTo-SurvivalProcessRow'},$true))
if($conversion.Count -ne 1){throw 'Host proof conversion missing'}
. ([scriptblock]::Create($conversion[0].Extent.Text))
if($IdentityOnly){
    function Invoke-HostProofQuery {
        param([switch]$IncludeListener,[int]$TimeoutMs=0)
        $rows=@(Get-CimInstance Win32_Process -Filter "ProcessId = $EditorPid" -ErrorAction Stop)
        return [pscustomobject]@{process=ConvertTo-SurvivalProcessRow $rows $EditorPid;listener_owners=@()}
    }
    # Keep the real process-row wrapper, parser and identity comparison. Only the
    # CIM boundary is synthetic; no process is queried, launched or terminated.
    function Get-CimInstance {
        param($ClassName,$Filter,$ErrorAction)
        $Queries.Add([pscustomobject]@{class=$ClassName;filter=$Filter;error_action=$ErrorAction})
        if($Scenario -ceq 'query_error'){throw 'controlled CIM query error'}
        if($Scenario -ceq 'missing_process'){return $null}
        $SyntheticProcessRow.ProcessId=$EditorPid
        return $SyntheticProcessRow
    }
    $results.Clear()
    $identityCases=@(
        @{name='valid'},@{name='creation_changed';error='identity changed at creation_utc'},
        @{name='pid_changed';error='identity changed at pid'},
        @{name='wrong_executable';error='executable mismatch'},
        @{name='session_missing';error='exact survival-session argument'},
        @{name='session_deceptive';error='exact survival-session argument'},
        @{name='project_missing';error='exact disposable project argument'},
        @{name='project_deceptive';error='exact disposable project argument'},
        @{name='command_line_changed';error='identity changed at command_line_sha256'},
        @{name='baseline_executable_changed';error='identity changed at executable_path'},
        @{name='baseline_session_changed';error='identity changed at session_token_sha256'},
        @{name='baseline_project_changed';error='identity changed at project_path'},
        @{name='missing_process';error='editor PID 42 does not exist'},
        @{name='query_error';error='controlled CIM query error'},
        @{name='uncaptured';error='editor identity was not captured'}
    )
    foreach($case in $identityCases){
        $EditorPid=42; $EditorExe='C:/fake/UnrealEditor.exe'; $ProjectPath='C:/fake/Scratch.uproject'; $SessionToken='disposable_test_token'
        $SyntheticProcessRow=[pscustomobject]@{ProcessId=$EditorPid;ExecutablePath=$EditorExe;CreationDate=[datetime]'2026-01-01T00:00:00Z';CommandLine="`"$ProjectPath`" -HaybaSurvivalSession=$SessionToken"}
        $Queries=[Collections.Generic.List[object]]::new()
        $Scenario='baseline'
        $EditorIdentity=New-EditorIdentity $EditorPid
        $baselineJson=$EditorIdentity|ConvertTo-Json -Compress
        $Queries.Clear()
        $Scenario=$case.name
        switch($Scenario){
            'creation_changed' {$SyntheticProcessRow.CreationDate=$SyntheticProcessRow.CreationDate.AddSeconds(1)}
            'pid_changed' {$EditorPid=43}
            'wrong_executable' {$SyntheticProcessRow.ExecutablePath='C:/fake/Other.exe'}
            'session_missing' {$SyntheticProcessRow.CommandLine="`"$ProjectPath`""}
            'session_deceptive' {$SyntheticProcessRow.CommandLine="`"$ProjectPath`" -HaybaSurvivalSession=${SessionToken}_suffix"}
            'project_missing' {$SyntheticProcessRow.CommandLine="-HaybaSurvivalSession=$SessionToken"}
            'project_deceptive' {$SyntheticProcessRow.CommandLine="`"${ProjectPath}.backup`" -HaybaSurvivalSession=$SessionToken"}
            'command_line_changed' {$SyntheticProcessRow.CommandLine+=' -Unattended'}
            'baseline_executable_changed' {$EditorIdentity.executable_path='C:/fake/Other.exe'}
            'baseline_session_changed' {$EditorIdentity.session_token_sha256='changed'}
            'baseline_project_changed' {$EditorIdentity.project_path='C:/fake/Other.uproject'}
            'uncaptured' {$EditorIdentity=$null}
        }
        $passed=$false; $reason=''
        try{
            $current=Assert-EditorIdentity
            if($case.ContainsKey('error')){throw 'Expected identity rejection was admitted'}
            if(($current|ConvertTo-Json -Compress) -cne $baselineJson){throw 'Validated identity fields were not retained'}
            if(@($current.PSObject.Properties).Count -ne 6 -or $current.pid -ne 42 -or $current.creation_utc -cne '2026-01-01T00:00:00.0000000Z' -or $current.command_line_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $current.session_token_sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Identity proof fields were incomplete'}
            $passed=$true
        }catch{
            $reason=$_.Exception.Message
            $passed=$case.ContainsKey('error') -and $reason -match $case.error
        }
        $expectedQueries=if($Scenario -ceq 'uncaptured'){0}else{1}
        if($Queries.Count -ne $expectedQueries){$passed=$false;$reason="Expected $expectedQueries fresh process query, got $($Queries.Count)"}
        foreach($query in $Queries){
            if($query.class -cne 'Win32_Process' -or $query.filter -cne "ProcessId = $EditorPid" -or $query.error_action -cne 'Stop'){$passed=$false;$reason='Process query lost its PID filter or error propagation'}
        }
        $results.Add([pscustomobject]@{name=$Scenario;passed=$passed;query_count=$Queries.Count;reason=$(if($passed){''}else{$reason})})
    }
    $results|ConvertTo-Json -Compress
    if(@($results|Where-Object{-not $_.passed}).Count){exit 1}
    exit 0
}
# Only OS/process/listener/time/transport boundaries are doubled. The source
# owns identity comparison, port selection, deadline accounting and admission.
function Get-EditorProcessRow {
    param([int]$ProcessId,[int]$TimeoutMs=0)
    if($TimeoutMs -gt 0 -and $StartupClock.ElapsedMilliseconds+$TimeoutMs -gt $StartupTimeoutMs){throw 'startup identity helper borrowed allowance beyond its deadline'}
    $StartupClock.ElapsedMilliseconds+=20
    if($Scenario -ceq 'process_death' -and $Requests.Count){throw 'editor PID does not exist'}
    $created=[datetime]'2026-01-01T00:00:00Z'
    if($Scenario -ceq 'identity_replaced' -and $Requests.Count){$created=$created.AddSeconds(1)}
    $exe=$EditorExe
    if($Scenario -ceq 'wrong_initial_identity'){$exe='C:/fake/Other.exe'}
    ConvertTo-SurvivalProcessRow @([pscustomobject]@{ProcessId=$ProcessId;ExecutablePath=$exe;CreationDate=$created;CommandLine="`"$ProjectPath`" -HaybaSurvivalSession=$SessionToken"}) $ProcessId
}
function Get-NetTCPConnection {
    param($OwningProcess,$LocalPort,$State,$ErrorAction)
    $StartupClock.ElapsedMilliseconds+=20
    if($Scenario -ceq 'listener_late' -and $StartupClock.ElapsedMilliseconds -lt 35000){return}
    $owner=42
    if($Scenario -in @('listener_replaced','explicit_foreign_port') -and ($Requests.Count -or $Scenario -ceq 'explicit_foreign_port')){$owner=99}
    [pscustomobject]@{LocalPort=52349;OwningProcess=$owner}
}
function Invoke-HostProofQuery {
    param([switch]$IncludeListener,[int]$TimeoutMs=0)
    $process=Get-EditorProcessRow $EditorPid $TimeoutMs
    $owners=@()
    if($IncludeListener){$owners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique)}
    return [pscustomobject]@{process=$process;listener_owners=$owners}
}
function Start-Sleep { param([int]$Milliseconds) $StartupClock.ElapsedMilliseconds+=$Milliseconds }
$Invoker={
    param($Cmd,$ParamsJson,$Port,$TimeoutMs,$Auth,$Owner,[switch]$ThrowOnTimeout)
    $Requests.Add([pscustomobject]@{command=$Cmd;timeout=$TimeoutMs;port=$Port;elapsed=$StartupClock.ElapsedMilliseconds})
    $global:LASTEXITCODE=0
    if($Cmd -cne 'ping' -or $Port -ne 52349){throw 'Unexpected startup command or port'}
    if($CaseClock -ne $null){return '{"id":"probe_case","ok":true}'}
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
$CaseMaxMs=$MaxCaseMs # The fixture creates synthetic clocks without Start-CaseBudget.
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
    $StartupReadinessEvidence=$null; $EditorIdentity=$null; $CaseClock=$null
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
        $CaseClock=[pscustomobject]@{ElapsedMilliseconds=0}
        Invoke-HaybaCommand -Command 'ping'|Out-Null
        if($Requests[-1].timeout -gt 500){throw 'Startup allowance leaked into hostile case'}
        $requestCount=$Requests.Count
        $CaseClock=[pscustomobject]@{ElapsedMilliseconds=501}
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
