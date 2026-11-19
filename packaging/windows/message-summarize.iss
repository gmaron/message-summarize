; message-summarize installer for Windows 11 (x64), built with Inno Setup 6 (OBJ-1, RNF-05, RNF-06, RNF-07, RF-80).
;
; It is built by scripts\build-windows-installer.ps1, which stages the payload and passes these defines:
;   AppName, AppVersion, AppPublisher  from package.json
;   StageDir    the staged payload: node\node.exe (private Node.js), app\ (package.json, package-lock.json, dist\ and
;               node_modules\ installed with `npm ci --omit=dev --ignore-scripts` from the lockfile), bin\msum.cmd,
;               bin\message-summarize.cmd, LICENSE, .message-summarize-prefix
;   OutputDir, OutputName  where the setup program goes and its name (without .exe)
;   Sign        optional: when defined, the sign tool named "msumsign" (passed to iscc with /S) signs the setup program
;               and the uninstaller. No certificate is ever stored in this repository.
;
; Per-user, no administrator rights: everything goes under %LOCALAPPDATA%\Programs\message-summarize, the PATH entry is
; in HKCU, and the daemon is registered with `msum service install` (the Run key of the user, RF-80).
;
; The data directory (%APPDATA%\message-summarize, or MSUM_DATA_DIR) is NEVER deleted or written by this installer
; other than through `msum init`. The uninstaller says where it is.
;
; Upgrade in place: run a newer setup over an older one. The old daemon is unregistered first (its launcher would
; otherwise start it again) and the node.exe processes that run from this install are stopped, the program files are
; replaced, and config.json, the databases and the sessions in the data directory are untouched. If the install does
; not finish, the service is registered again (best effort).
;
; Restart Manager: Setup uses it (CloseApplications=yes) to find and close applications that hold files it replaces.
; The UNINSTALLER is not documented to do that (CloseApplications is a Setup directive), so it stops the daemon itself
; (StopDaemons) before Inno deletes anything. Not verified against a real uninstall: see the smoke test in release.yml.

#ifndef AppName
  #error AppName is not defined (scripts\build-windows-installer.ps1 passes it from package.json)
#endif
#ifndef AppVersion
  #error AppVersion is not defined (scripts\build-windows-installer.ps1 passes it from package.json)
#endif
#ifndef AppPublisher
  #error AppPublisher is not defined (scripts\build-windows-installer.ps1 passes it from package.json)
#endif
#ifndef StageDir
  #error StageDir is not defined
#endif
#ifndef OutputDir
  #error OutputDir is not defined
#endif
#ifndef OutputName
  #error OutputName is not defined
#endif

#define CliRelative "app\dist\main\cli.js"
#define PrefixMarker ".message-summarize-prefix"

[Setup]
; Fixed forever: it is how a newer setup recognizes (and upgrades) an older install. Never change it.
AppId={{7D3C9B52-4E1A-4F6B-9A83-5C0E2B6D1F47}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\message-summarize
DisableProgramGroupPage=yes
; No administrator rights, and no way to ask for them: PrivilegesRequiredOverridesAllowed is left empty on purpose.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile={#StageDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\node\node.exe
; The PATH entry is written to HKCU\Environment: tell the open windows.
ChangesEnvironment=yes
; A running daemon (node.exe of this install) holds its files: Restart Manager asks to close it before they are replaced
; (Setup also stops the daemons of this install on its own, see StopDaemons).
CloseApplications=yes
CloseApplicationsFilter=*.exe
RestartApplications=no
; No setup log by default (it can be asked for with /LOG); the installer never writes a token anywhere.
SetupLogging=no
#ifdef Sign
SignTool=msumsign
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[CustomMessages]
english.TaskPath=Add message-summarize to the PATH of your user (so msum works in any terminal)
english.TaskService=Start message-summarize when I sign in to Windows
english.TaskOpen=Open the web when the installation ends
english.StatusInit=Creating the configuration (an existing one is kept)...
english.StatusService=Registering the daemon to start at login...
english.StatusDaemon=Starting the daemon...
english.PrefixData=Setup will not use %1 as the install folder because it overlaps your data folder (%2). Choose another folder.
english.PrefixNotOurs=Setup will not use %1 as the install folder: it is not empty and was not created by this installer. Choose an empty folder.
english.PrefixTooBroad=Setup will not use %1 as the install folder: it is too broad. Choose a folder of its own, for example %2.
english.UpgradeServiceFail=The daemon of the installed version could not be unregistered, so nothing was changed.%n%nRemove it by hand and run Setup again:%n  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v message-summarize /f%nThen close the daemon (end node.exe in Task Manager).
english.UnSvcFail=The background service could not be removed, so nothing was uninstalled and your data was not touched.%n%nTo remove it by hand, run in a terminal:%n  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v message-summarize /f%nThen run the uninstaller again.
english.UnNoCli=The program files needed to remove the background service are missing. The uninstall continues, but the daemon may still be registered. To remove it by hand, run in a terminal:%n  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v message-summarize /f
english.UnConfirm=Uninstalling will first stop and remove the background service (the daemon), then remove the program. Your data is NOT deleted: it stays in%n%n%1%n%nContinue?
english.InitFail=The program is installed, but its configuration could not be created (msum init failed). Open a terminal and run: msum init
english.UnDataKept=message-summarize was removed. Your data was NOT deleted: it is in%n%n%1%n%nDelete that folder yourself if you want to erase it.

spanish.TaskPath=Agregar message-summarize al PATH de tu usuario (para usar msum en cualquier terminal)
spanish.TaskService=Iniciar message-summarize cuando inicie sesión en Windows
spanish.TaskOpen=Abrir la web cuando termine la instalación
spanish.StatusInit=Creando la configuración (una existente se conserva)...
spanish.StatusService=Registrando el daemon para que arranque al iniciar sesión...
spanish.StatusDaemon=Iniciando el daemon...
spanish.PrefixData=Setup no usará %1 como carpeta de instalación porque se superpone con tu carpeta de datos (%2). Elegí otra carpeta.
spanish.PrefixNotOurs=Setup no usará %1 como carpeta de instalación: no está vacía y no la creó este instalador. Elegí una carpeta vacía.
spanish.PrefixTooBroad=Setup no usará %1 como carpeta de instalación: es demasiado amplia. Elegí una carpeta propia, por ejemplo %2.
spanish.UpgradeServiceFail=No se pudo quitar el registro del daemon de la versión instalada, así que no se cambió nada.%n%nQuitalo a mano y volvé a ejecutar Setup:%n  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v message-summarize /f%nDespués cerrá el daemon (finalizá node.exe en el Administrador de tareas).
spanish.UnSvcFail=No se pudo quitar el servicio en segundo plano, así que no se desinstaló nada y tus datos no se tocaron.%n%nPara quitarlo a mano, ejecutá en una terminal:%n  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v message-summarize /f%nDespués volvé a ejecutar el desinstalador.
spanish.UnNoCli=Faltan los archivos del programa necesarios para quitar el servicio en segundo plano. La desinstalación continúa, pero el daemon puede seguir registrado. Para quitarlo a mano, ejecutá en una terminal:%n  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v message-summarize /f
spanish.UnConfirm=Al desinstalar se detiene y quita primero el servicio en segundo plano (el daemon) y después el programa. Tus datos NO se borran: quedan en%n%n%1%n%n¿Continuar?
spanish.InitFail=El programa se instaló, pero no se pudo crear su configuración (falló msum init). Abrí una terminal y ejecutá: msum init
spanish.UnDataKept=Se quitó message-summarize. Tus datos NO se borraron: están en%n%n%1%n%nBorrá esa carpeta vos si querés eliminarlos.

[Tasks]
Name: "addtopath"; Description: "{cm:TaskPath}"
Name: "service"; Description: "{cm:TaskService}"
Name: "openweb"; Description: "{cm:TaskOpen}"

[Files]
Source: "{#StageDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#StageDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\{#PrefixMarker}"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; An upgrade is a clean replace of the program (a dependency that the new version no longer has must not stay behind).
; Only the program folders of THIS install: never anything in the data directory.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"

[UninstallDelete]
; Files that Setup installed are removed by the uninstaller on its own. These folders are listed so that nothing the
; package left inside them survives. NOTHING here may point at the data directory: it is never deleted.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\bin"

[Run]
; msum init creates the data folder and the configuration; an existing one is kept. It never asks anything.
Filename: "{app}\node\node.exe"; Parameters: """{app}\{#CliRelative}"" init"; StatusMsg: "{cm:StatusInit}"; Flags: runhidden waituntilterminated
Filename: "{app}\node\node.exe"; Parameters: """{app}\{#CliRelative}"" service install"; StatusMsg: "{cm:StatusService}"; Tasks: service; Flags: runhidden waituntilterminated
; The Run key only takes effect at the next login, so the launcher is started now, unless a daemon is already up.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{code:LauncherPath}"""; StatusMsg: "{cm:StatusDaemon}"; Tasks: service; Check: ShouldStartDaemon; Flags: runhidden nowait
; `msum open` runs in its own console and prints the address with the token there, once. Setup never reads or logs it.
Filename: "{app}\node\node.exe"; Parameters: """{app}\{#CliRelative}"" open"; Tasks: openweb; Check: WebIsUp; Flags: nowait skipifsilent runasoriginaluser

[Code]
const
  EnvKey = 'Environment';
  StateKey = 'Software\message-summarize\Installer';
  RunKeyPath = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunValueName = 'message-summarize';

var
  { The Run value was there before this setup removed it for an upgrade: put back if the install does not finish. }
  ServiceWasRemoved: Boolean;
  { Set when the install ended (ssDone). }
  InstallDone: Boolean;

{ ---- paths ---- }

{ Where msum keeps its data: MSUM_DATA_DIR, else %APPDATA%\message-summarize (src/main/paths.ts). }
function DataDir(Param: String): String;
var
  Explicit: String;
begin
  Explicit := Trim(GetEnv('MSUM_DATA_DIR'));
  if Explicit <> '' then
    Result := ExpandFileName(Explicit)
  else
    Result := ExpandConstant('{userappdata}\message-summarize');
end;

function LauncherPath(Param: String): String;
begin
  Result := AddBackslash(DataDir('')) + 'daemon-launcher.ps1';
end;

function NodeExe: String;
begin
  Result := ExpandConstant('{app}\node\node.exe');
end;

function CliJs: String;
begin
  Result := ExpandConstant('{app}\{#CliRelative}');
end;

function BinDir: String;
begin
  Result := ExpandConstant('{app}\bin');
end;

{ Runs `msum <Args>` hidden with the private Node.js. Nothing it prints is captured or logged. }
function RunCli(const Args: String; var Code: Integer): Boolean;
begin
  Result := Exec(NodeExe, '"' + CliJs + '" ' + Args, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PathInside(const Child, Parent: String): Boolean;
var
  C, P: String;
begin
  C := Uppercase(AddBackslash(RemoveBackslashUnlessRoot(ExpandFileName(Child))));
  P := Uppercase(AddBackslash(RemoveBackslashUnlessRoot(ExpandFileName(Parent))));
  Result := Copy(C, 1, Length(P)) = P;
end;

function IsDirEmpty(const Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Result := False;
          Break;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

{ ---- the daemon ---- }

{ The web answers only while a daemon holds the lock: `msum open --print` succeeds then. Its output is discarded. }
function DaemonIsUp: Boolean;
var
  Code: Integer;
begin
  Result := RunCli('open --print', Code) and (Code = 0);
end;

function ShouldStartDaemon: Boolean;
begin
  Result := FileExists(LauncherPath('')) and not DaemonIsUp;
end;

{ Waits for the daemon to open the web (up to 30 s when it was just started), like install.sh. }
function WebIsUp: Boolean;
var
  Tries, MaxTries: Integer;
begin
  Result := False;
  MaxTries := 1;
  if WizardIsTaskSelected('service') then
    MaxTries := 30;
  for Tries := 1 to MaxTries do
  begin
    if DaemonIsUp then
    begin
      Result := True;
      Break;
    end;
    if Tries < MaxTries then
      Sleep(1000);
  end;
end;

{ Stops the node.exe processes that run from THIS install ({app}\node\node.exe), and only those, so their files can be
  replaced or deleted. It is a hard stop (the daemon keeps its data in SQLite, which survives it). Call it after
  `service uninstall`, or the launcher would start the daemon again. The path goes in as a parameter of a small
  ASCII script, so no quoting of the path is needed inside the script. }
procedure StopDaemons;
var
  Script: String;
  Code: Integer;
begin
  Script := ExpandConstant('{tmp}\msum-stop-daemon.ps1');
  if not SaveStringToFile(Script,
    'param([string]$Dir)' + #13#10 +
    '$prefix = $Dir.TrimEnd(''\'') + ''\''' + #13#10 +
    'Get-CimInstance Win32_Process -Filter "Name = ''node.exe''" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' + #13#10,
    False) then
    Exit;
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -Dir "' + RemoveBackslash(ExpandConstant('{app}')) + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1500); { let Windows release the files }
end;

{ ---- checks before anything is replaced (they also run in a silent install) ---- }

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir, Data: String;
  ExitCode: Integer;
  Registered: Boolean;
begin
  Result := '';
  Dir := RemoveBackslashUnlessRoot(ExpandFileName(WizardDirValue));
  Data := DataDir('');

  { The program folder and the data folder must never overlap: an upgrade replaces the program folder wholesale and
    the uninstaller removes it. }
  if PathInside(Dir, Data) or PathInside(Data, Dir) then
  begin
    Result := FmtMessage(CustomMessage('PrefixData'), [Dir, Data]);
    Exit;
  end;

  { Too broad: a drive root, or the home, AppData or Documents folders themselves. }
  if (Length(Dir) <= 3) or SameText(Dir, RemoveBackslashUnlessRoot(GetEnv('USERPROFILE')))
     or SameText(Dir, RemoveBackslashUnlessRoot(ExpandConstant('{localappdata}')))
     or SameText(Dir, RemoveBackslashUnlessRoot(ExpandConstant('{userappdata}')))
     or SameText(Dir, RemoveBackslashUnlessRoot(ExpandConstant('{userdocs}'))) then
  begin
    Result := FmtMessage(CustomMessage('PrefixTooBroad'), [Dir, ExpandConstant('{localappdata}\Programs\message-summarize')]);
    Exit;
  end;

  { A folder that has something in it and is not a previous install of this program is not ours to fill or to delete. }
  if DirExists(Dir) and not IsDirEmpty(Dir) and not FileExists(AddBackslash(Dir) + '{#PrefixMarker}') then
  begin
    Result := FmtMessage(CustomMessage('PrefixNotOurs'), [Dir]);
    Exit;
  end;

  { An upgrade: unregister the old daemon first. Its launcher would start the daemon again right after it is stopped,
    and the new files could not be copied. Then the daemons of this install are stopped. Nothing has been changed
    yet when this fails. If the install does not finish, DeinitializeSetup registers the service again. }
  if FileExists(NodeExe) and FileExists(CliJs) then
  begin
    Registered := RegValueExists(HKCU, RunKeyPath, RunValueName);
    if not RunCli('service uninstall', ExitCode) or (ExitCode <> 0) then
      Result := CustomMessage('UpgradeServiceFail')
    else if Registered then
    begin
      ServiceWasRemoved := True;
      StopDaemons;
    end;
  end;
end;

{ ---- the PATH of the user (HKCU\Environment), idempotent, case-insensitive ---- }

{ Path without the entries equal to Entry (ignoring case and a final backslash). Found says whether there was one.
  Empty entries are dropped too. }
function RemovePathEntry(const Path, Entry: String; var Found: Boolean): String;
var
  Rest, Item, Want: String;
  P: Integer;
begin
  Result := '';
  Found := False;
  Want := Uppercase(RemoveBackslashUnlessRoot(Entry));
  Rest := Path;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end
    else
    begin
      Item := Copy(Rest, 1, P - 1);
      Delete(Rest, 1, P);
    end;
    if Item <> '' then
    begin
      if Uppercase(RemoveBackslashUnlessRoot(Item)) = Want then
        Found := True
      else
      begin
        if Result <> '' then
          Result := Result + ';';
        Result := Result + Item;
      end;
    end;
  end;
end;

procedure AddToUserPath;
var
  Old, Entry: String;
  Found: Boolean;
begin
  Entry := BinDir;
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Old) then
    Old := '';
  RemovePathEntry(Old, Entry, Found);
  { Already there: whoever put it there keeps it. The marker below is only written when this installer adds it. }
  if Found then
    Exit;
  if (Old <> '') and (Copy(Old, Length(Old), 1) <> ';') then
    Old := Old + ';';
  if RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Old + Entry) then
    RegWriteStringValue(HKCU, StateKey, 'PathAdded', '1');
end;

procedure RemoveFromUserPath;
var
  Old, Cleaned, Marker: String;
  Found: Boolean;
begin
  { Only what this installer added is removed. }
  if not RegQueryStringValue(HKCU, StateKey, 'PathAdded', Marker) or (Marker <> '1') then
    Exit;
  if RegQueryStringValue(HKCU, EnvKey, 'Path', Old) then
  begin
    Cleaned := RemovePathEntry(Old, BinDir, Found);
    if Found then
      RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Cleaned);
  end;
  RegDeleteKeyIncludingSubkeys(HKCU, StateKey);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then
    AddToUserPath;
  if CurStep = ssDone then
    InstallDone := True;
end;

{ The end of Setup, finished or not. }
procedure DeinitializeSetup;
var
  Code: Integer;
  Keep: Boolean;
begin
  { The service was unregistered for the upgrade and the install did not finish, or the service task was off: put it
    back, best effort (it only needs the program, which may be gone if the install stopped half way). }
  if ServiceWasRemoved then
  begin
    Keep := False;
    if InstallDone then
      Keep := WizardIsTaskSelected('service');
    if (not Keep) and FileExists(NodeExe) and FileExists(CliJs) then
      RunCli('service install', Code);
  end;
  { msum init (a [Run] step) does not report its exit code: a missing configuration is how its failure shows. }
  if InstallDone and not FileExists(AddBackslash(DataDir('')) + 'config.json') then
    SuppressibleMsgBox(CustomMessage('InitFail'), mbError, MB_OK, IDOK);
end;

{ ---- uninstall ---- }

{ Asks first (the service is not touched before the user agrees), then removes the service FIRST, while the program
  that knows how is still there. When it cannot be removed the uninstall stops: nothing is deleted, and the message
  gives the manual step. The daemons of this install are stopped, and the data directory is never touched. }
function InitializeUninstall: Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if not UninstallSilent then
  begin
    if MsgBox(FmtMessage(CustomMessage('UnConfirm'), [DataDir('')]), mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := False;
      Exit;
    end;
  end;
  if FileExists(NodeExe) and FileExists(CliJs) then
  begin
    if not RunCli('service uninstall', ExitCode) or (ExitCode <> 0) then
    begin
      SuppressibleMsgBox(CustomMessage('UnSvcFail'), mbError, MB_OK, IDOK);
      Result := False;
    end
    else
      StopDaemons;
  end
  else
    SuppressibleMsgBox(CustomMessage('UnNoCli'), mbInformation, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath;
  if CurUninstallStep = usDone then
    SuppressibleMsgBox(FmtMessage(CustomMessage('UnDataKept'), [DataDir('')]), mbInformation, MB_OK, IDOK);
end;
