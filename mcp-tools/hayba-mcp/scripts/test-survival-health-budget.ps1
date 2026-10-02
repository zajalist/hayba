param([Parameter(Mandatory=$true)][string]$HarnessPath)
$ErrorActionPreference='Stop'
$names=@('monotonic_remaining','expired_transport_not_invoked','late_transport_rejected',
 'slow_preflight_cannot_satisfy_command_minimum','long_command_has_separate_duration',
 'partial_identity_failure','partial_listener_failure','partial_evidence_failure',
 'unique_listener_owner','foreign_listener_rejected','ambiguous_listener_rejected',
 'missing_process_rejected','ambiguous_process_rejected','queried_pid_mismatch_rejected',
 'synthetic_owner_all_caller_paths','read_declarations_are_narrow',
 'fresh_owned_helper_query',
 'owned_hanging_helper_exit','oversized_helper_output_rejected','malformed_helper_output_rejected',
 'nonzero_helper_exit_rejected','unconfirmed_helper_exit_blocks_further_queries','cleanup_identity_timeout_never_terminates',
 'startup_query_remaining_propagation','startup_identity_expiry_blocks_listener','startup_post_ping_expiry_blocks_listener',
 'cleanup_later_query_timeout_never_terminates','cleanup_later_identity_mismatch_never_terminates',
 'cleanup_later_unconfirmed_helper_never_terminates','cleanup_wm_wait_identity_failure_never_forces',
 'cleanup_missing_listener_retains_owned_fallback')
$ScenarioResults=[Collections.Generic.List[object]]::new()
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($HarnessPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Harness parse failed'}
$actual=@{}
$required=@('Get-SanitizedHash','New-DiagnosticDigest','Get-RemainingCaseMs','Invoke-HaybaCommand',
 'Assert-EditorIdentity','New-EditorIdentity','New-CaseClock','Start-CaseBudget','Invoke-CasePhase','Add-Result','Test-CommandRejection',
 'Assert-CaseTarget','Assert-EditorHealthy','Get-EditorState','Test-BenignPythonNonce',
 'Initialize-HostProofCapture','Start-HostProofProcess','Invoke-HostProofQuery','Get-ListenerOwner',
 'Get-BigEndianHeader','New-RawCommandFrame','Wait-EditorReady','Get-RemainingStartupMs',
 'Get-EditorProcessRow','Wait-OwnedProcessExit','Stop-OwnedEditorWithEvidence')
foreach($name in $required){
 $found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($found.Count -ne 1){
  foreach($scenario in $names){$ScenarioResults.Add([pscustomobject]@{name=$scenario;passed=$false;diagnostic='bounded production helper missing'})}
  $ScenarioResults|ConvertTo-Json -Compress -Depth 12;exit 1
 }
 $actual[$name]=[scriptblock]::Create($found[0].Extent.Text)
}
$helperPath=Join-Path (Split-Path -Parent $HarnessPath) 'query-survival-host-proof.ps1'
$helperAst=[Management.Automation.Language.Parser]::ParseFile($helperPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Host query helper parse failed'}
foreach($name in @('Resolve-FullPath','Test-ExactCommandLineArgument','ConvertTo-SurvivalProcessRow')){
 $found=@($helperAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($found.Count -ne 1){throw 'Host query validation helper missing'}
 $actual[$name]=[scriptblock]::Create($found[0].Extent.Text)
}
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Must-Reject([scriptblock]$Action,[string]$Pattern){
 $rejected=$false
 try{& $Action|Out-Null}catch{$rejected=$_.Exception.Message -match $Pattern}
 Require $rejected 'Expected rejection did not occur'
}
$MaxStoredDiagnosticChars=4096;$MaxCaseMs=10000;$EditorPid=42;$Port=52349;$Auth=''
$EditorExe='C:/fake/UnrealEditor.exe';$ProjectPath='C:/fake/Scratch.uproject';$SessionToken='synthetic_session_token'
$SurvivalOwner='survival-'+[guid]::NewGuid().ToString('N')
$InitialEditorState=[pscustomobject]@{map='baseline';pie_running=$false;dirty_packages=@();dirty_count=0}
$initialRow=[pscustomobject]@{ProcessId=42;ExecutablePath=$EditorExe;CreationDate=[datetime]'2026-01-01T00:00:00Z';CommandLine="`"$ProjectPath`" -HaybaSurvivalSession=$SessionToken"}
$fixtureFiles=[Collections.Generic.List[string]]::new()
try {
 foreach($scenario in $names){
  foreach($definition in $actual.Values){. $definition}
  $script:FakeClock=[pscustomobject]@{ElapsedMilliseconds=0}
  function New-CaseClock{return $FakeClock}
  Start-CaseBudget
  $script:Results=[Collections.Generic.List[object]]::new();$script:Requests=[Collections.Generic.List[object]]::new()
  $script:LastHostQueryEvidence=$null
  $script:UnaccountedHostProofProcess=$null
  $passed=$false;$diagnostic=''
  try {
   switch($scenario){
    'monotonic_remaining' {
     $FakeClock.ElapsedMilliseconds=1234
     Require ((Get-RemainingCaseMs) -eq 8766) 'Remaining budget did not use monotonic elapsed time'
     $CaseDeadline=[datetime]::UtcNow.AddDays(-5)
     Require ((Get-RemainingCaseMs) -eq 8766) 'UTC leaked into case accounting'
     $Invoker={param($Cmd,$ParamsJson,$Port,$TimeoutMs) $Requests.Add($TimeoutMs);$global:LASTEXITCODE=0;'{"ok":true}'}
     Invoke-HaybaCommand ping|Out-Null
     Require ($Requests[0] -eq 8766) 'Transport did not receive exact remaining allowance'
    }
    'expired_transport_not_invoked' {
     $FakeClock.ElapsedMilliseconds=9901
     $Invoker={param($Cmd) $Requests.Add($Cmd);$global:LASTEXITCODE=0;'{"ok":true}'}
     Must-Reject {Invoke-HaybaCommand ping} 'absolute 10000ms case deadline'
     Require ($Requests.Count -eq 0) 'Expired case invoked transport'
     Must-Reject {Invoke-HostProofQuery -IncludeListener} 'absolute 10000ms case deadline'
    }
    'late_transport_rejected' {
     $Invoker={param($Cmd) $FakeClock.ElapsedMilliseconds=10001;$global:LASTEXITCODE=0;'{"ok":true}'}
     Must-Reject {Invoke-HaybaCommand ping} 'absolute 10000ms case deadline'
    }
    {$_ -in @('slow_preflight_cannot_satisfy_command_minimum','long_command_has_separate_duration')} {
     function Assert-CaseTarget{$FakeClock.ElapsedMilliseconds+=4500;[pscustomobject]@{complete=$true}}
     function Invoke-HaybaCommand{param($Command,$Params) $FakeClock.ElapsedMilliseconds+=$(if($scenario -ceq 'long_command_has_separate_duration'){4000}else{10});[pscustomobject]@{ok=$false;error='deadline'}}
     function Assert-EditorHealthy{$FakeClock.ElapsedMilliseconds+=100;[pscustomobject]@{complete=$true}}
     if($scenario -ceq 'slow_preflight_cannot_satisfy_command_minimum'){
      Must-Reject {Test-CommandRejection 'duration' 'python_run' @{} 'deadline' 4000} 'hostile command returned'
      Require (-not $Results[0].passed -and $Results[0].hostile_duration_ms -eq 10 -and $Results[0].preflight.complete) 'Failed case lost command duration or preflight'
     }else{
      Test-CommandRejection 'duration' 'python_run' @{} 'deadline' 4000
      Require ($Results[0].passed -and $Results[0].hostile_duration_ms -eq 4000 -and $Results[0].duration_ms -eq 8600) 'Command duration included preflight'
     }
    }
    {$_ -in @('partial_identity_failure','partial_listener_failure','partial_evidence_failure')} {
     function Invoke-HostProofQuery {
      param([switch]$IncludeListener)
      Invoke-CasePhase ($HealthPhasePrefix+'.identity') {if($scenario -ceq 'partial_identity_failure'){throw 'controlled identity failure'}}|Out-Null
      Invoke-CasePhase ($HealthPhasePrefix+'.listener') {if($scenario -ceq 'partial_listener_failure'){throw 'controlled listener failure'}}|Out-Null
      [pscustomobject]@{process=$null;listener_owners=@(42)}
     }
     function Assert-EditorIdentity{param($ProcessRow)}
     function Invoke-HaybaCommand{param($Command,$Params) $Requests.Add($Command);[pscustomobject]@{ok=$true;data=@{map='baseline';pie_running=$false;dirty_count=0;dirty_packages=@()}}}
     function Test-BenignPythonNonce{param($ExpectPolicyRefusal)[pscustomobject]@{executed=$true;nonce_ok=$true;nonce_sha256='safe';policy_refusal_ok=$false}}
     function Assert-CrashEvidenceUnchanged{throw 'controlled evidence failure'}
     $script:HealthPhasePrefix='preflight'
     Must-Reject {Assert-EditorHealthy} 'controlled'
     Add-Result 'partial' $false $FakeClock.ElapsedMilliseconds 'controlled failure'
     $failed=@($Results[0].phases|Where-Object{$_.status -ceq 'failed'})
     Require ($failed.Count -ge 1 -and $null -eq $Results[0].recovery) 'Partial failure claimed complete recovery'
     Require (@($Results[0].phases|Where-Object{$_.status -ceq 'started'}).Count -eq 0) 'Phase finalization lost on failure'
     if($scenario -cne 'partial_evidence_failure'){Require ($Requests.Count -eq 0) 'Identity/listener failure sent ping'}
     else{Require (@($Results[0].phases|Where-Object{$_.status -ceq 'completed'}).Count -ge 4) 'Completed earlier phases lost'}
    }
    'unique_listener_owner' {Require ((Get-ListenerOwner -Owners @(42,42)) -eq 42) 'Equivalent listener rows rejected'}
    'foreign_listener_rejected' {Must-Reject {Get-ListenerOwner -Owners @(99)} 'listener ownership changed'}
    'ambiguous_listener_rejected' {Must-Reject {Get-ListenerOwner -Owners @(42,99)} 'exactly one listener'}
    'missing_process_rejected' {
     Must-Reject {ConvertTo-SurvivalProcessRow @() 42} 'does not exist'
     Must-Reject {ConvertTo-SurvivalProcessRow @($null) 42} 'does not exist'
    }
    'ambiguous_process_rejected' {Must-Reject {ConvertTo-SurvivalProcessRow @($initialRow,$initialRow) 42} 'ambiguous'}
    'queried_pid_mismatch_rejected' {Must-Reject {ConvertTo-SurvivalProcessRow @($initialRow) 43} 'queried PID mismatch'}
    'synthetic_owner_all_caller_paths' {
     $Invoker={param($Cmd,$ParamsJson,$Port,$TimeoutMs,$Auth,$Owner,[switch]$ThrowOnTimeout)$Requests.Add([pscustomobject]@{command=$Cmd;owner=$Owner});$global:LASTEXITCODE=0;'{"ok":true}'}
     Invoke-HaybaCommand ping|Out-Null
     $StartupClock=[pscustomobject]@{ElapsedMilliseconds=0};$StartupTimeoutMs=10000
     function New-EditorIdentity{param($ProcessId)[pscustomobject]@{pid=$ProcessId}}
     function Assert-EditorIdentity{}
     function Get-ListenerOwner{return 42}
     Wait-EditorReady|Out-Null
     $frame=New-RawCommandFrame 'python_run' @{script='sum(range(1000000))'} 'raw_id'
     $raw=[Text.Encoding]::UTF8.GetString($frame.body)|ConvertFrom-Json
     Require ($Requests.Count -eq 2 -and @($Requests|Where-Object{$_.owner -cne $SurvivalOwner}).Count -eq 0 -and $raw.owner -ceq $SurvivalOwner) 'Owner missing from actual caller path'
     Require (-not $raw.params.PSObject.Properties['read_only']) 'Raw Python became declared read'
     $ownerAssignments=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$SurvivalOwner'},$true))
     Require ($ownerAssignments.Count -eq 1) 'Expected one owner initialization'
     $first=$SurvivalOwner;. ([scriptblock]::Create($ownerAssignments[0].Extent.Text));$second=$SurvivalOwner
     Require ($first -cne $second -and $second -cmatch '^survival-[a-f0-9]{32}$') 'Owner initialization was reused or impersonated'
    }
    'read_declarations_are_narrow' {
     $Invoker={param($Cmd,$ParamsJson,$Port,$TimeoutMs,$Auth,$Owner) $Requests.Add(($ParamsJson|ConvertFrom-Json));$marker=[regex]::Match($ParamsJson,'__HAYBA_NONCE__[a-f0-9]{32}').Value;$global:LASTEXITCODE=0;@{ok=$true;data=@{stdout=$marker}}|ConvertTo-Json -Compress}
     Test-BenignPythonNonce|Out-Null
     Require ($Requests[0].read_only -is [bool] -and $Requests[0].read_only) 'Nonce read declaration absent'
     $declared=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.HashtableAst] -and $n.Extent.Text -match 'read_only\s*=\s*\$true'},$true))
     Require ($declared.Count -eq 2) 'Unexpected read declaration outside two reviewed probes'
     Require (@($declared|Where-Object{$_.Extent.Text -match 'environmentScript'}).Count -eq 1) 'Environment probe read declaration absent'
    }
    'fresh_owned_helper_query' {
     Initialize-HostProofCapture
     $fixtureHelper=$helperPath
     if([OperatingSystem]::IsLinux()){
      # The production helper uses Windows CIM. Inject only a live /proc CIM
      # adapter into a temporary copy, retaining its validation and event path.
      $fixtureHelper=Join-Path ([IO.Path]::GetTempPath()) ('hayba-host-proof-linux-'+[guid]::NewGuid().ToString('N')+'.ps1')
      $fixtureFiles.Add($fixtureHelper)
      $source=Get-Content -Raw -LiteralPath $helperPath
      $insertion='$ErrorActionPreference=''Stop'''
      Require ([regex]::Matches($source,[regex]::Escape($insertion)).Count -eq 1) 'Host proof adapter insertion point changed'
      $adapter=Get-Content -Raw -LiteralPath (Join-Path (Split-Path -Parent $HarnessPath) 'test-survival-cim-linux-adapter.ps1')
      Set-Content -LiteralPath $fixtureHelper -Value ($source.Replace($insertion,"$insertion`n$adapter")) -Encoding utf8
     }
     $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node -ErrorAction Stop).Source)
     $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true
     $info.ArgumentList.Add('-e')
     $info.ArgumentList.Add('const net=require("net");const s=net.createServer();let n=0;function open(){s.listen(0,"127.0.0.1",()=>{const p=s.address().port;if(p>=52342&&p<=52350){if(++n>=32)process.exit(2);s.close(open);return;}console.log(JSON.stringify({port:p}));});}open();setTimeout(()=>process.exit(0),20000);')
     foreach($arg in @('--',$ProjectPath,"-HaybaSurvivalSession=$SessionToken")){$info.ArgumentList.Add($arg)}
     $fixture=[Diagnostics.Process]::new();$fixture.StartInfo=$info
     Require ($fixture.Start()) 'Owned query fixture did not start'
     $capture=[HaybaHostProofCapture]::new();$capture.Start($fixture.StandardOutput.BaseStream)
     $fixtureClock=[Diagnostics.Stopwatch]::StartNew()
     try {
      while(-not $capture.Snapshot().Contains("`n")){
       Require ($fixtureClock.ElapsedMilliseconds -lt 3000 -and -not $fixture.HasExited) 'Owned query fixture readiness failed'
       [Threading.Thread]::Sleep(10)
      }
      $ready=$capture.Snapshot().Trim()|ConvertFrom-Json
      Require ($ready.port -gt 0 -and $ready.port -notin 52342..52350) 'Fixture selected a real MCP port'
      $EditorPid=$fixture.Id;$EditorExe=$fixture.MainModule.FileName;$Port=[int]$ready.port
      $HostProofHelper=$fixtureHelper;$CaseClock=$null
      $proof=Invoke-HostProofQuery -IncludeListener -TimeoutMs 7000
      $EditorIdentity=New-EditorIdentity $EditorPid -ProcessRow $proof.process
      Require ((Get-ListenerOwner -Owners $proof.listener_owners) -eq $EditorPid -and $LastHostQueryEvidence.exit_confirmed) 'Exact listener or helper exit absent'
      $fresh=Invoke-HostProofQuery -IncludeListener -TimeoutMs 7000
      Assert-EditorIdentity -ProcessRow $fresh.process|Out-Null
      Require ($LastHostQueryEvidence.exit_confirmed) 'Second fresh helper exit absent'
     }finally {
      # Query helper exit is already asserted before fixture teardown.
      if(-not $fixture.HasExited){$fixture.Kill()}
      Require ($fixture.WaitForExit(1000) -and $capture.Work.Wait(1000)) 'Owned fixture exit unconfirmed'
      $fixture.Dispose();$EditorPid=42;$EditorExe='C:/fake/UnrealEditor.exe';$Port=52349
     }
    }
    {$_ -in @('owned_hanging_helper_exit','oversized_helper_output_rejected','malformed_helper_output_rejected','nonzero_helper_exit_rejected')} {
     Initialize-HostProofCapture
     $path=Join-Path ([IO.Path]::GetTempPath()) ('hayba-host-proof-test-'+[guid]::NewGuid().ToString('N')+'.ps1')
     $fixtureFiles.Add($path)
     $body=switch($scenario){
      'owned_hanging_helper_exit' {'[Console]::Out.WriteLine(''{"kind":"phase","phase":"identity","state":"started","start_tick":0}'');Start-Sleep -Seconds 20'}
      'oversized_helper_output_rejected' {'[Console]::Out.Write((''x''*20000));Start-Sleep -Seconds 20'}
      'malformed_helper_output_rejected' {'[Console]::Out.WriteLine(''not-json'')'}
      'nonzero_helper_exit_rejected' {'exit 9'}
     }
     Set-Content -LiteralPath $path -Value $body -Encoding utf8
     $HostProofHelper=$path
     $startDefinition=(Get-Item Function:Start-HostProofProcess).ScriptBlock
     function Start-HostProofProcess{param($Arguments) $proc=& $startDefinition $Arguments;$script:ObservedChild=[Diagnostics.Process]::GetProcessById($proc.Id);return $proc}
     $script:ObservedChild=$null;$CaseClock=$null
     Must-Reject {Invoke-HostProofQuery -IncludeListener -TimeoutMs 1500} 'host proof|helper'
     Require ($null -ne $ObservedChild -and $ObservedChild.WaitForExit(1000) -and $LastHostQueryEvidence.exit_confirmed) 'Helper exit not proved before fixture teardown'
     $ObservedChild.Dispose()
     Require ([Diagnostics.Process]::GetCurrentProcess().Id -eq $PID) 'Parent was retargeted'
     if($scenario -ceq 'owned_hanging_helper_exit'){Require ($LastHostQueryEvidence.timed_out) 'Hang did not fail as timeout'}
    }
    'unconfirmed_helper_exit_blocks_further_queries' {
     Initialize-HostProofCapture
     $script:Starts=0;$CaseClock=$null
     function Start-HostProofProcess {
      param($Arguments)
      $script:Starts++
      $fake=[pscustomobject]@{Id=777;HasExited=$false;StandardOutput=[pscustomobject]@{BaseStream=[IO.MemoryStream]::new()};StandardError=[pscustomobject]@{BaseStream=[IO.MemoryStream]::new()};kills=0}
      $fake|Add-Member ScriptMethod WaitForExit {param($TimeoutMs)return $false}
      $fake|Add-Member ScriptMethod Kill {$this.kills++}
      return $fake
     }
     $HostProofHelper=$helperPath
     Must-Reject {Invoke-HostProofQuery -TimeoutMs 1000} 'host proof helper'
     Require (-not $LastHostQueryEvidence.exit_confirmed -and $UnaccountedHostProofProcess.kills -eq 1) 'Unconfirmed helper was treated as accounted'
     Must-Reject {Invoke-HostProofQuery -TimeoutMs 1000} 'previous host proof helper'
     Require ($Starts -eq 1) 'Unconfirmed helper allowed another owned query'
     $UnaccountedHostProofProcess.StandardOutput.BaseStream.Dispose();$UnaccountedHostProofProcess.StandardError.BaseStream.Dispose()
    }
    'cleanup_identity_timeout_never_terminates' {
     $OwnsTarget=$true;$script:TerminationCalls=0
     function Get-Process{param($Id,$ErrorAction)[pscustomobject]@{Id=$Id}}
     function Assert-EditorIdentity{throw [TimeoutException]::new('controlled identity timeout')}
     function Stop-Process{$script:TerminationCalls++}
     function Invoke-HaybaCommand{$script:TerminationCalls++}
     Must-Reject {Stop-OwnedEditorWithEvidence} 'controlled identity timeout'
     Require ($TerminationCalls -eq 0) 'Cleanup terminated after identity timeout'
    }
    {$_ -in @('startup_query_remaining_propagation','startup_identity_expiry_blocks_listener','startup_post_ping_expiry_blocks_listener')} {
     $StartupTimeoutMs=1000;$StartupClock=[pscustomobject]@{ElapsedMilliseconds=0};$CaseClock=$null
     if($scenario -ceq 'startup_identity_expiry_blocks_listener'){$StartupClock.ElapsedMilliseconds=790}
     $script:QueryAllowances=[Collections.Generic.List[object]]::new()
     function Get-EditorProcessRow {
      param($ProcessId,[int]$TimeoutMs=0)
      $QueryAllowances.Add([pscustomobject]@{kind='identity';timeout=$TimeoutMs;start=$StartupClock.ElapsedMilliseconds})
      if(($scenario -ceq 'startup_identity_expiry_blocks_listener' -and $QueryAllowances.Count -eq 2) -or
         ($scenario -ceq 'startup_post_ping_expiry_blocks_listener' -and $Requests.Count)){$StartupClock.ElapsedMilliseconds=1000}
      else{$StartupClock.ElapsedMilliseconds+=10}
      ConvertTo-SurvivalProcessRow @($initialRow) $ProcessId
     }
     function Invoke-HostProofQuery {
      param([switch]$IncludeListener,[int]$TimeoutMs=0)
      $QueryAllowances.Add([pscustomobject]@{kind='listener';timeout=$TimeoutMs;start=$StartupClock.ElapsedMilliseconds})
      $StartupClock.ElapsedMilliseconds+=10
      [pscustomobject]@{process=ConvertTo-SurvivalProcessRow @($initialRow) $EditorPid;listener_owners=@(42)}
     }
     $Invoker={param($Cmd,$ParamsJson,$Port,$TimeoutMs,$Auth,$Owner,[switch]$ThrowOnTimeout)
      $Requests.Add($Cmd);$StartupClock.ElapsedMilliseconds+=20;$global:LASTEXITCODE=0;'{"ok":true}'}
     if($scenario -ceq 'startup_query_remaining_propagation'){
      Wait-EditorReady|Out-Null
      Require (($QueryAllowances.timeout -join ',') -ceq '0,990,980,950,940') 'Startup helper did not receive each fresh remaining allowance'
      Require ($StartupReadinessEvidence.ready) 'Correctly bounded startup did not become ready'
     }else{
      Must-Reject {Wait-EditorReady} 'startup deadline'
      $listeners=@($QueryAllowances|Where-Object{$_.kind -ceq 'listener'})
      $expected=if($scenario -ceq 'startup_identity_expiry_blocks_listener'){0}else{1}
      Require ($listeners.Count -eq $expected) 'Startup launched listener query after identity consumed its remainder'
      Require (-not $StartupReadinessEvidence.ready) 'Expired startup claimed readiness'
     }
    }
    {$_ -in @('cleanup_later_query_timeout_never_terminates','cleanup_later_identity_mismatch_never_terminates',
       'cleanup_later_unconfirmed_helper_never_terminates','cleanup_wm_wait_identity_failure_never_forces',
       'cleanup_missing_listener_retains_owned_fallback')} {
     $OwnsTarget=$true;$CaseClock=$null;$GracefulShutdownTimeoutMs=1000
     $script:CloseCalls=0;$script:ForceCalls=0;$script:IdentityCalls=0;$script:WaitEntered=$false;$script:WaitFailureInjected=$false
     $InitialCrashEvidence=[pscustomobject]@{state_sha256='safe';artifact_count=0;signature_count=0}
     $InitialFilesystemEvidence=[pscustomobject]@{state_sha256='safe';tracked_file_count=0}
     function Assert-EditorIdentity {
      param($ProcessRow,[int]$TimeoutMs=0)
      $script:IdentityCalls++
      if($scenario -ceq 'cleanup_later_identity_mismatch_never_terminates' -and $null -ne $ProcessRow){throw 'controlled later identity mismatch'}
      if($scenario -ceq 'cleanup_wm_wait_identity_failure_never_forces' -and $WaitEntered -and -not $WaitFailureInjected){
       $script:WaitFailureInjected=$true;throw [TimeoutException]::new('controlled WM wait identity timeout')
      }
     }
     function Invoke-HostProofQuery {
      param([switch]$IncludeListener,[int]$TimeoutMs=0)
      if($scenario -ceq 'cleanup_later_query_timeout_never_terminates'){throw [TimeoutException]::new('controlled later identity query timeout')}
      if($scenario -ceq 'cleanup_later_unconfirmed_helper_never_terminates'){throw 'controlled later helper exit unconfirmed'}
      [pscustomobject]@{process=[pscustomobject]@{fresh=$true};listener_owners=@()}
     }
     $owned=[pscustomobject]@{Id=42}
     $owned|Add-Member ScriptMethod CloseMainWindow {$script:CloseCalls++;return $true}
     function Get-Process {
      param($Id,$ErrorAction)
      if($ForceCalls -gt 0 -or ($scenario -ceq 'cleanup_missing_listener_retains_owned_fallback' -and $CloseCalls -gt 0)){return}
      return $owned
     }
     $actualWait=(Get-Item Function:Wait-OwnedProcessExit).ScriptBlock
     function Wait-OwnedProcessExit{param($TimeoutMs)$script:WaitEntered=$true;& $actualWait $TimeoutMs}
     function Get-EditorState{throw 'ordinary unavailable socket state'}
     function Stop-Process{param($Id,[switch]$Force,$ErrorAction)$script:ForceCalls++}
     function Start-Sleep{param($Milliseconds)}
     function Get-CrashEvidence{return $InitialCrashEvidence}
     function Get-ProjectFilesystemEvidence{return $InitialFilesystemEvidence}
     function Read-NewCriticalLogEvidence{[pscustomobject]@{critical_count=0}}
     if($scenario -ceq 'cleanup_missing_listener_retains_owned_fallback'){
      $cleanup=Stop-OwnedEditorWithEvidence
      Require ($cleanup.exited -and $CloseCalls -eq 1 -and $ForceCalls -eq 0) 'Missing listener disabled safe owned graceful fallback'
     }else{
      Must-Reject {Stop-OwnedEditorWithEvidence} 'controlled'
      $expectedClose=if($scenario -ceq 'cleanup_wm_wait_identity_failure_never_forces'){1}else{0}
      Require ($CloseCalls -eq $expectedClose -and $ForceCalls -eq 0) 'Cleanup continued termination after identity/query failure'
      if($WaitFailureInjected){Require ($IdentityCalls -eq 4) 'Cleanup revalidated again after failed WM identity proof'}
     }
    }
   }
   $passed=$true
  }catch{$diagnostic=$_.Exception.Message}
  $ScenarioResults.Add([pscustomobject]@{name=$scenario;passed=$passed;diagnostic=$diagnostic;host_query=$LastHostQueryEvidence})
 }
}finally {
 foreach($file in $fixtureFiles){if(-not ([IO.Path]::GetFullPath($file).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase))){throw 'Fixture path escaped temporary directory'};Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue}
}
$ScenarioResults|ConvertTo-Json -Compress -Depth 12
if(@($ScenarioResults|Where-Object{-not $_.passed}).Count){exit 1}
