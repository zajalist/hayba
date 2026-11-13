; Hayba Windows installer. Built by tools/build-installer.mjs, which passes:
;   /DPackageZip=<package.zip>  /DInstallerDir=<tools/installer>  /DAppVersion=0.4.2  /DWithMcp=1|0
; WithMcp=1 -> "Plugin+MCP": installs the plugin and registers the MCP server for Claude Code / Claude Desktop / Cursor.
; WithMcp=0 -> "Plugin": installs the plugin only.
; Screens: choose project -> install -> finished. Per-user, no admin.

#if WithMcp == "1"
  #define Variant "Plugin+MCP"
  #define VariantDir "PluginMcp"
  #define AppGuid "{{6F3B2E4A-7C1D-4E8F-9A2B-1D5E0C7A9B31}"
#else
  #define Variant "Plugin"
  #define VariantDir "Plugin"
  #define AppGuid "{{2B8D4C1E-5A3F-4B7E-8C9D-3E6F1A2B4C57}"
#endif

[Setup]
AppId={#AppGuid}
AppName=Hayba ({#Variant})
AppVersion={#AppVersion}
AppPublisher=Hayba
AppPublisherURL=https://github.com/zajalist/hayba
UninstallDisplayName=Hayba {#AppVersion} ({#Variant})
DefaultDirName={localappdata}\Hayba\{#VariantDir}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Hayba-Setup-{#AppVersion}-{#Variant}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes

[Files]
Source: "{#PackageZip}"; Flags: dontcopy
; The uninstaller runs these to remove Hayba from each project it was installed into.
Source: "{#InstallerDir}\Install.ps1"; DestDir: "{app}"
Source: "{#InstallerDir}\Installer.Core.ps1"; DestDir: "{app}"

[Code]
var
  ProjectPage: TInputFileWizardPage;
  EngineLabel: TNewStaticText;
  ClaudeCodeBox, ClaudeDesktopBox, CursorBox: TNewCheckBox;
  ResultText: String;

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function FindEngine59: String;
begin
  Result := '';
  if not RegQueryStringValue(HKLM64, 'SOFTWARE\EpicGames\Unreal Engine\5.9', 'InstalledDirectory', Result) then
    if DirExists(ExpandConstant('{commonpf64}\Epic Games\UE_5.9\Engine')) then
      Result := ExpandConstant('{commonpf64}\Epic Games\UE_5.9');
end;

function AddCheck(const Caption: String; Top: Integer; Checked: Boolean): TNewCheckBox;
begin
  Result := TNewCheckBox.Create(ProjectPage);
  Result.Parent := ProjectPage.Surface;
  Result.Caption := Caption;
  Result.Top := Top;
  Result.Width := ProjectPage.SurfaceWidth;
  Result.Height := ScaleY(20);
  Result.Checked := Checked;
end;

procedure InitializeWizard;
var
  Engine: String;
  Top: Integer;
begin
  ProjectPage := CreateInputFilePage(wpWelcome, 'Choose your Unreal project',
    'Hayba will be added to this project''s Plugins folder.',
    'Save your work and close this project in Unreal, then select its .uproject file.');
  ProjectPage.Add('Unreal project (.uproject):', 'Unreal projects (*.uproject)|*.uproject', '.uproject');
  ProjectPage.Values[0] := ExpandConstant('{param:PROJECT|}');

  EngineLabel := TNewStaticText.Create(ProjectPage);
  EngineLabel.Parent := ProjectPage.Surface;
  EngineLabel.Top := ProjectPage.Edits[0].Top + ProjectPage.Edits[0].Height + ScaleY(12);
  EngineLabel.Width := ProjectPage.SurfaceWidth;
  EngineLabel.AutoSize := False;
  EngineLabel.WordWrap := True;
  EngineLabel.Height := ScaleY(32);
  Engine := FindEngine59;
  if Engine <> '' then
    EngineLabel.Caption := 'Unreal Engine 5.9 found: ' + Engine
  else
    EngineLabel.Caption := 'Unreal Engine 5.9 was not found in the usual place. Setup will search other installs; install 5.9 from the Epic Games Launcher if it fails.';
  Top := EngineLabel.Top + EngineLabel.Height + ScaleY(8);

#if WithMcp == "1"
  ClaudeCodeBox := AddCheck('Connect Claude Code (this project''s .mcp.json)', Top, True);
  ClaudeDesktopBox := AddCheck('Connect Claude Desktop', Top + ScaleY(24), DirExists(ExpandConstant('{userappdata}\Claude')));
  CursorBox := AddCheck('Connect Cursor', Top + ScaleY(48), DirExists(ExpandConstant('{%USERPROFILE}\.cursor')));
#endif
end;

function Quote(const S: String): String;
begin
  Result := '"' + S + '"';
end;

function RunPowerShell(const Params: String; var Output: String): Integer;
var
  Captured: TExecOutput;
  I: Integer;
begin
  Output := '';
  if not ExecAndCaptureOutput(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass ' + Params, '', SW_HIDE, ewWaitUntilTerminated, Result, Captured) then
    Result := -1;
  for I := 0 to GetArrayLength(Captured.StdOut) - 1 do
    Output := Output + Captured.StdOut[I] + #13#10;
  for I := 0 to GetArrayLength(Captured.StdErr) - 1 do
    Output := Output + Captured.StdErr[I] + #13#10;
end;

function ErrorFrom(const Output: String): String;
var
  P: Integer;
begin
  P := Pos('HAYBA_ERROR ', Output);
  if P > 0 then Result := Trim(Copy(Output, P + 12, Length(Output)))
  else Result := Trim(Output);
  if Result = '' then Result := 'PowerShell could not run the installer.';
end;

// Installs into Project; returns '' or an error message. Runs from the project page (interactive) or
// from PrepareToInstall for silent installs: Setup.exe /VERYSILENT /PROJECT="C:\Game\Game.uproject" [/CLIENTS=code,desktop,cursor]
function DoInstall(const Project: String): String;
var
  Pkg, Output, Flags, Clients: String;
begin
  Result := '';
  if (Project = '') or not FileExists(Project) or (CompareText(ExtractFileExt(Project), '.uproject') <> 0) then
  begin
    Result := 'Choose an existing .uproject file.';
    exit;
  end;
  Pkg := ExpandConstant('{tmp}\pkg');
  if not DirExists(Pkg) then
  begin
    ExtractTemporaryFile('package.zip');
    if RunPowerShell('-Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(''' +
      ExpandConstant('{tmp}\package.zip') + ''',''' + Pkg + ''')"', Output) <> 0 then
    begin
      DelTree(Pkg, True, True, True);
      Result := 'Setup could not unpack Hayba: ' + ErrorFrom(Output);
      exit;
    end;
  end;
  Flags := ' -ReplaceExisting';
#if WithMcp == "1"
  Clients := ExpandConstant('{param:CLIENTS|}');
  if Clients <> '' then
  begin
    ClaudeCodeBox.Checked := Pos('code', Clients) > 0;
    ClaudeDesktopBox.Checked := Pos('desktop', Clients) > 0;
    CursorBox.Checked := Pos('cursor', Clients) > 0;
  end;
  if ClaudeCodeBox.Checked then Flags := Flags + ' -ClaudeCode';
  if ClaudeDesktopBox.Checked then Flags := Flags + ' -ClaudeDesktop';
  if CursorBox.Checked then Flags := Flags + ' -Cursor';
#endif
  if RunPowerShell('-File ' + Quote(Pkg + '\installer\Install.ps1') + ' -PackageRoot ' + Quote(Pkg) + ' -Project ' + Quote(Project) + Flags, Output) <> 0 then
    Result := 'Hayba was not installed. Your project was not changed.'#13#10#13#10 + ErrorFrom(Output)
  else
    ResultText := Output;
  Log(Output);
end;

// Install as soon as the project is chosen, so a problem (Unreal still open, wrong engine)
// is reported on this page and the user can fix it and press Install again.
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Error: String;
begin
  Result := True;
  if (CurPageID <> ProjectPage.ID) or WizardSilent then exit;
  WizardForm.NextButton.Enabled := False;
  WizardForm.BackButton.Enabled := False;
  try
    Error := DoInstall(Trim(ProjectPage.Values[0]));
  finally
    WizardForm.NextButton.Enabled := True;
    WizardForm.BackButton.Enabled := True;
  end;
  if Error <> '' then
  begin
    MsgBox(Error, mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if WizardSilent then Result := DoInstall(Trim(ProjectPage.Values[0]));
end;
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = ProjectPage.ID then WizardForm.NextButton.Caption := 'Install';
  if CurPageID = wpFinished then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'Hayba is installed';
    WizardForm.FinishedLabel.Caption :=
      'Hayba was added to ' + ProjectPage.Values[0] + '.'#13#10#13#10 +
      '1. Open the project in Unreal Engine 5.9.'#13#10 +
      '2. Open Tools > Hayba MCP Toolkit, then Settings to choose a provider and enter your API key.'#13#10
#if WithMcp == "1"
      + '3. Restart Claude Code, Claude Desktop or Cursor and ask it to "check the Hayba Unreal connection".'#13#10
#endif
      ;
    if Pos('Note:', ResultText) > 0 then
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10 + Trim(Copy(ResultText, Pos('Note:', ResultText), 600));
  end;
end;

// Remember each project so the uninstaller can remove Hayba from all of them.
procedure CurStepChanged(CurStep: TSetupStep);
var
  List: AnsiString;
begin
  if CurStep <> ssPostInstall then exit;
  if not LoadStringFromFile(ExpandConstant('{app}\projects.txt'), List) then List := '';
  if Pos(ProjectPage.Values[0] + #13#10, List) = 0 then
    SaveStringToFile(ExpandConstant('{app}\projects.txt'), ProjectPage.Values[0] + #13#10, True);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Lines: TArrayOfString;
  I: Integer;
  Output, Failed: String;
begin
  if CurUninstallStep <> usUninstall then exit;
  if not LoadStringsFromFile(ExpandConstant('{app}\projects.txt'), Lines) then exit;
  Failed := '';
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Trim(Lines[I]) <> '' then
      if RunPowerShell('-File ' + Quote(ExpandConstant('{app}\Install.ps1')) + ' -Uninstall -Project ' + Quote(Trim(Lines[I])), Output) <> 0 then
        Failed := Failed + Trim(Lines[I]) + ': ' + ErrorFrom(Output) + #13#10;
  if Failed <> '' then
    MsgBox('Hayba could not be removed from:'#13#10#13#10 + Failed + #13#10'Close Unreal for these projects and delete their Plugins\HaybaMCPToolkit folder manually.', mbError, MB_OK);
  DeleteFile(ExpandConstant('{app}\projects.txt'));
end;
