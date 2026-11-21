[Setup]
AppId=HaybaDesktopPreview
AppName=Hayba Desktop Preview
AppVersion=0.1.0
DefaultDirName={localappdata}\Programs\Hayba Desktop
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=bin
OutputBaseFilename=Hayba-Desktop-Setup
Compression=lzma2/fast
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\Hayba.exe

[Files]
Source: "bin\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
Source: "bin\plugin\Hayba-Setup-0.4.2-Plugin+MCP.exe"; DestDir: "{app}\Unreal"

[Icons]
Name: "{userprograms}\Hayba Desktop"; Filename: "{app}\Hayba.exe"
Name: "{userprograms}\Set up Hayba for Unreal"; Filename: "{app}\Unreal\Hayba-Setup-0.4.2-Plugin+MCP.exe"

[Run]
Filename: "{app}\Unreal\Hayba-Setup-0.4.2-Plugin+MCP.exe"; Description: "Set up the Unreal Engine 5.9 plugin for a project"; Flags: postinstall unchecked skipifsilent
Filename: "{app}\Hayba.exe"; Description: "Open Hayba Desktop"; Flags: postinstall nowait skipifsilent
