param([Parameter(Mandatory=$true)][string]$HarnessPath)
$ErrorActionPreference = 'Stop'
$errors=$null; $tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($HarnessPath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Survival harness did not parse' }
foreach ($name in @('Get-SanitizedHash','Get-EditorState','Test-BenignPythonNonce','Assert-CaseTarget','Assert-EditorHealthy')) {
    $definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
    if($definitions.Count -ne 1){throw "Expected exactly one health helper: $name"}
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
# Test doubles stand in for native/transport boundaries; exact source health
# helpers still decide admission, baseline checks, and evidence truthfulness.
function Assert-EditorIdentity {}
function Get-ListenerOwner { return 42 }
function Assert-CrashEvidenceUnchanged { return $InitialCrashEvidence }
function Assert-ProjectFilesystemUnchanged { return $InitialFilesystemEvidence }
function Read-NewCriticalLogEvidence { return [pscustomobject]@{critical_count=0} }
function Invoke-HaybaCommand {
    param([string]$Command,[hashtable]$Params=@{})
    $Requests.Add($Command)
    if($Command -ceq 'ping') { return [pscustomobject]@{ok=($Scenario -cne 'failed_ping')} }
    if($Command -ceq 'editor_get_state') {
        if($Scenario -ceq 'failed_correlation'){throw 'transport correlation failed'}
        return [pscustomobject]@{ok=($Scenario -cne 'failed_native_read');data=@{
            map= $(if($Scenario -ceq 'wrong_map'){'changed'}else{'baseline'})
            pie_running=$MockPie;dirty_count=0
            dirty_packages= $(if($Scenario -ceq 'dirty_state'){@('dirty')}else{@()})
        }}
    }
    if($Command -cne 'python_run'){throw 'Unexpected mock command'}
    $marker=[regex]::Match($Params.script,'__HAYBA_NONCE__[0-9a-f]{32}').Value
    if(-not $marker){throw 'Health probe did not generate a bounded nonce'}
    if($MockPie){
        $response=[pscustomobject]@{ok=$false;code='pie_active';data=@{stdout=''}}
        if($Scenario -ceq 'pie_unexpected_success'){$response.ok=$true;$response.data.stdout=$marker}
        if($Scenario -ceq 'pie_wrong_code'){$response.code='policy_blocked'}
        if($Scenario -ceq 'pie_missing_code'){$response.code=$null}
        if($Scenario -ceq 'pie_malformed_ok'){$response.ok='false'}
        if($Scenario -ceq 'pie_malformed_code'){$response.code=@('pie_active')}
        if($Scenario -ceq 'pie_stdout'){$response.data.stdout='execution output'}
        if($Scenario -ceq 'pie_nonce_echo'){$response.data.stdout=$marker}
        if($Scenario -ceq 'pie_top_stdout'){$response|Add-Member -NotePropertyName stdout -NotePropertyValue 'execution output'}
        if($Scenario -ceq 'pie_nonce_in_error'){$response|Add-Member -NotePropertyName error -NotePropertyValue $marker}
        return $response
    }
    $stdout=switch($Scenario){'missing_nonce'{''};'wrong_nonce'{'__HAYBA_NONCE__wrong'};default{$marker}}
    return [pscustomobject]@{ok=($Scenario -cne 'outside_refusal');data=@{stdout=$stdout}}
}
function Test-Proof([object]$Proof,[bool]$Pie){
    if($Proof.native_state_request_id_correlated -ne $true){throw 'Native correlation evidence missing'}
    if($Proof.python_nonce_executed -ne (-not $Pie)){throw 'Python execution evidence incorrect'}
    if($Pie){
        if($null -ne $Proof.python_nonce_ok -or $null -ne $Proof.python_nonce_sha256 -or $Proof.python_policy_refusal_ok -ne $true){throw 'PIE refusal evidence incorrect'}
    }else{
        if($Proof.python_nonce_ok -ne $true -or $Proof.python_policy_refusal_ok -ne $false -or $Proof.python_nonce_sha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'Python success evidence incorrect'}
    }
}
$EditorPid=42
$InitialEditorState=[pscustomobject]@{map='baseline';pie_running=$false;dirty_packages=@();dirty_count=0}
$InitialCrashEvidence=[pscustomobject]@{artifact_count=1;signature_count=0}
$InitialFilesystemEvidence=[pscustomobject]@{tracked_file_count=3}
$results=[Collections.Generic.List[object]]::new()
$cases=@(
    @{name='outside_pie'},@{name='expected_pie'},@{name='start_stop_proofs'},
    @{name='pie_unexpected_success';error='PIE Python admission'},@{name='pie_wrong_code';error='PIE Python admission'},
    @{name='pie_missing_code';error='PIE Python admission'},@{name='pie_stdout';error='PIE Python admission'},
    @{name='pie_malformed_ok';error='PIE Python admission'},@{name='pie_malformed_code';error='PIE Python admission'},
    @{name='pie_top_stdout';error='PIE Python admission'},@{name='pie_nonce_in_error';error='PIE Python admission'},
    @{name='pie_nonce_echo';error='PIE Python admission'},@{name='missing_nonce';error='benign Python nonce'},
    @{name='wrong_nonce';error='benign Python nonce'},@{name='outside_refusal';error='benign Python nonce'},
    @{name='unexpected_pie';error='editor world baseline'},@{name='expected_pie_absent';error='editor world baseline'},
    @{name='wrong_map';error='editor world baseline'},@{name='dirty_state';error='dirty-package baseline'},
    @{name='failed_native_read';error='editor-state probe'},@{name='failed_correlation';error='transport correlation'},
    @{name='failed_ping';error='fresh correlated ping'}
)
foreach($case in $cases){
    $Scenario=$case.name
    $MockPie=$Scenario.StartsWith('pie_') -or $Scenario -in @('expected_pie','unexpected_pie')
    $expectedPie=$MockPie
    if($Scenario -ceq 'unexpected_pie'){$expectedPie=$false}
    if($Scenario -ceq 'expected_pie_absent'){$expectedPie=$true}
    $Requests=[Collections.Generic.List[string]]::new()
    $passed=$false
    try{
        if($Scenario -ceq 'start_stop_proofs'){
            $MockPie=$false;Test-Proof (Assert-CaseTarget -ExpectedPieRunning $false) $false
            $MockPie=$true;Test-Proof (Assert-CaseTarget -ExpectedPieRunning $true) $true
            $MockPie=$true;Test-Proof (Assert-CaseTarget -ExpectedPieRunning $true) $true
            $MockPie=$false;Test-Proof (Assert-CaseTarget -ExpectedPieRunning $false) $false
        }else{
            Test-Proof (Assert-EditorHealthy -ExpectedPieRunning $expectedPie) $expectedPie
        }
        $passed=-not $case.ContainsKey('error')
    }catch{
        $passed=$case.ContainsKey('error') -and $_.Exception.Message.StartsWith($case.error,[StringComparison]::Ordinal)
    }
    if($Requests.Contains('python_run') -and $Requests.IndexOf('python_run') -lt $Requests.IndexOf('editor_get_state')){$passed=$false}
    if($Scenario -in @('unexpected_pie','expected_pie_absent','wrong_map','dirty_state','failed_native_read','failed_correlation') -and $Requests.Contains('python_run')){$passed=$false}
    $results.Add([pscustomobject]@{name=$Scenario;passed=$passed})
}
$results|ConvertTo-Json -Compress
if(@($results|Where-Object{-not $_.passed}).Count){exit 1}
exit 0
