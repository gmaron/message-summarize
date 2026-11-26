<#
.SYNOPSIS
  message-summarize installer for Windows 11 (x64). OBJ-1, RNF-05, RNF-06, RNF-07.

.DESCRIPTION
  irm https://raw.githubusercontent.com/gmaron/message-summarize/main/packaging/install.ps1 | iex
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/gmaron/message-summarize/main/packaging/install.ps1))) -NoService
  .\packaging\install.ps1 -Tarball .\message-summarize-0.1.0.tgz -DryRun

  No administrator rights, nothing outside your user profile and HKCU. It installs the package with its own copy of
  Node.js (or the one you already have, when it is recent enough), puts msum.cmd and message-summarize.cmd in
  <prefix>\bin, creates the configuration, registers the daemon in the Run key of your user (msum service install) and
  opens the web. Run it again to upgrade.
  The only hosts it talks to are nodejs.org (only when Node.js is missing), the npm registry (or the https tarball URL
  you give) and nothing else. No telemetry. It never prints the web token itself: msum open does, once.

  A command piped to iex cannot take parameters, so every option has an environment variable too:
  MSUM_VERSION, MSUM_TARBALL, MSUM_PREFIX, MSUM_NO_SERVICE, MSUM_NO_OPEN, MSUM_MODIFY_PATH, MSUM_UNINSTALL,
  MSUM_DRY_RUN, MSUM_YES (1 or true to switch on). MSUM_LANG (en or es) overrides the language of the messages.

  Exit codes: 0 done | 1 failure | 2 wrong arguments | 3 unsupported system (use Docker) | 4 a tool is missing |
              5 checksum mismatch | 6 installed, but the service could not be registered

.PARAMETER Version
  npm version or dist-tag to install (default: latest). A caret range is not accepted: use an exact version or a tag.
.PARAMETER Tarball
  Install from a release tarball (an existing file or an https:// URL).
.PARAMETER Prefix
  Where the program goes (default: %LOCALAPPDATA%\message-summarize-app). The commands go in <prefix>\bin.
.PARAMETER NoService
  Do not register the daemon in the Run key.
.PARAMETER NoOpen
  Do not open the web at the end.
.PARAMETER ModifyPath
  Add <prefix>\bin to the user PATH (HKCU\Environment). Otherwise the exact command is only printed.
.PARAMETER Uninstall
  Remove the program and the commands (your data is never deleted).
.PARAMETER DryRun
  Print what would be done and change nothing.
.PARAMETER Yes
  Do not ask for confirmation.
.PARAMETER Help
  This help.
#>
param(
  [string]$Version,
  [string]$Tarball,
  [string]$Prefix,
  [switch]$NoService,
  [switch]$NoOpen,
  [switch]$ModifyPath,
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Help
)

# Everything below lives inside one function that is called on the very last line: a script cut short by a dropped
# connection (irm | iex) fails to parse and runs nothing. Nothing leaks into the session of the caller either.
function Invoke-MsumInstaller {
  [CmdletBinding()]
  param(
    [string]$Version,
    [string]$Tarball,
    [string]$Prefix,
    [switch]$NoService,
    [switch]$NoOpen,
    [switch]$ModifyPath,
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Help
  )

  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # Pinned Node.js LTS (>= 22.16, the engines of the package). Bump together with a release, and with install.sh.
  $NodeVersion = '22.23.5'
  $NodeMinMajor = 22
  $NodeMinMinor = 16
  $NodeDist = 'https://nodejs.org/dist'
  $PackageName = 'message-summarize'
  $DockerUrl = 'https://github.com/gmaron/message-summarize#docker'
  $ShimMark = 'REM message-summarize shim (managed by install.ps1)'
  $PrefixMarker = '.message-summarize-prefix'
  $RunKeyPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
  $RunValue = 'message-summarize'
  $LauncherName = 'daemon-launcher.ps1'
  $Sep = [string][System.IO.Path]::DirectorySeparatorChar

  # The file this runs from, empty under iex or a script block (where an exit would close the terminal of the person).
  $ScriptFile = [string](Get-Variable -Name PSCommandPath -ValueOnly -ErrorAction SilentlyContinue)

  # State shared with the nested functions (they see the variables of this one).
  $S = @{
    Tmp               = ''
    PrefixGiven       = $false
    ModulesAside      = $false
    ExitCode          = 0
    Interactive       = $false
    NodeBin           = ''
    NodeNeedsDownload = $false
  }

  # ---- messages (English, and Spanish when the language of the session is Spanish) ---------------------------------

  function MessagesEn {
    return @{
      Start          = 'Installing message-summarize into {0}'
      NodeFound      = 'Using Node.js {0} ({1})'
      NodePrivate    = 'Using the private Node.js {0}'
      StepNode       = 'download Node.js {0} from nodejs.org, verify its SHA-256 and unpack it into {1}'
      NodeDownload   = 'Node.js 22.16 or later was not found. Downloading a private copy (Node.js {0}, about 35 MB). Your system is not touched.'
      Verify         = 'Verifying the download (SHA-256)'
      BadSum         = 'The download does not match the official checksum. Nothing was installed. Try again later.'
      NoSum          = 'Could not read the official checksum for {0}. Nothing was installed.'
      ZipUnsafe      = 'The Node.js archive has an entry that would be unpacked outside its folder. Nothing was installed.'
      Unsupported    = 'Unsupported system: {0} {1}. Use the Docker image instead: {2}'
      NoTool         = 'A required tool is missing: {0}. Install Node.js 22.16 or later from nodejs.org and run the installer again.'
      StepInstall    = 'install {0} with npm into {1} (without running install scripts)'
      Installing     = 'Installing {0} (this can take a minute)'
      InstallFail    = 'npm could not install the package. The messages above say why (network, registry or version).'
      NoCli          = 'The package was installed but {0} is missing. The package looks broken.'
      StepShims      = 'create the commands {0} and {1}'
      Shims          = 'Commands created: {0} and {1}'
      ShimForeign    = '{0} exists and was not created by this installer. Move it away and run the installer again.'
      PathHint       = '{0} is not on your PATH. To use msum from any terminal, run this once (or run the installer again with -ModifyPath):'
      StepModifyPath = 'add {0} to your user PATH (HKCU\Environment)'
      PathAdded      = 'Added {0} to your user PATH. Open a new terminal for it to take effect.'
      PathPresent    = '{0} is already in your user PATH.'
      PathFail       = 'Could not edit your user PATH. To use msum from any terminal, run this once:'
      StepInit       = 'run msum init (creates the data folder and the configuration; an existing one is kept)'
      StepService    = 'run msum service install (the daemon starts when you sign in; no administrator rights)'
      StepOpen       = 'open the web with msum open'
      ServiceFail    = 'The service could not be registered. You can run the daemon by hand with: msum daemon'
      ServiceSkip    = 'Skipped the service (-NoService). To start the daemon by hand: msum daemon'
      WebNotUp       = 'The web is not up yet (the daemon starts the next time you sign in). To start it now run msum daemon in another terminal, then: msum open'
      OpenFail       = 'Could not open a browser. Open the address above by hand.'
      Done           = 'Done. Next: link your WhatsApp from the web, or run: msum link'
      DryHeader      = 'Dry run: nothing is changed. The installer would:'
      DryItem        = '  - {0}'
      UnStart        = 'Uninstalling message-summarize from {0}'
      UnService      = 'Removing the service'
      UnNothing      = 'Nothing to remove at {0}'
      UnStep         = 'remove {0}, {1} and {2} (your data is kept)'
      UnDone         = 'Removed the program. Your data was NOT deleted: it is in {0}. Delete that folder yourself if you want to erase it.'
      UnPathRemoved  = 'Removed {0} from your user PATH.'
      UnCancel       = 'Cancelled.'
      UnKeep         = 'Your data was not touched: {0}'
      Confirm        = 'Continue? [Y/n] '
      BadArg         = 'Invalid option value: {0}'
      BadVersion     = 'Invalid -Version: {0}'
      BadTarball     = 'Cannot use -Tarball {0}: it must be an existing file or an https:// URL.'
      BadPrefix      = 'Refusing to use {0} as the install folder: {1}'
      PrefixNotOurs  = 'it is not empty and was not created by this installer'
      PrefixData     = 'it contains your data folder ({0})'
      PrefixUnsafe   = 'it is too broad'
      PrefixChars    = 'its path has a character the command shims cannot hold (a percent sign or a double quote)'
      NoHome         = 'USERPROFILE is not set to an existing folder.'
      PrefixInData   = 'it is inside your data folder ({0})'
      InitFail       = 'msum init failed (see above). The program is installed; run msum init again once the problem is fixed.'
      DownloadFail   = 'Could not download {0}. Nothing was installed. Check your connection and try again.'
      UnSvcFail      = 'The service could not be removed (see above). Nothing was deleted. Fix that and run the uninstaller again.'
      UnManual       = 'The program files are gone, but the background service is still registered and its program is no longer there. Remove it by hand (in PowerShell):'
      Abort          = 'Interrupted.'
      Waiting        = 'Waiting for the web to start'
      StopDaemon     = 'Stopping the running daemon'
      DaemonStart    = 'Starting the daemon'
      UnLocked       = 'Could not move {0} out of the way: a file in it is in use (the daemon or a terminal running msum). Nothing was deleted. Close them and run the uninstaller again.'
      UnLeft         = 'The program is removed, but this folder could not be deleted completely: {0}. Delete it yourself once nothing uses it.'
      InstallLocked  = 'Could not replace the previous installation because a file is in use (the daemon or a terminal running msum). Close them and run the installer again. The previous version was kept.'
      Help           = 'Usage: .\install.ps1 [-Version <v>] [-Tarball <file|url>] [-Prefix <dir>] [-NoService] [-NoOpen] [-ModifyPath] [-Uninstall] [-DryRun] [-Yes]'
    }
  }

  function MessagesEs {
    $es = @{
      Start          = 'Instalando message-summarize en {0}'
      NodeFound      = 'Usando Node.js {0} ({1})'
      NodePrivate    = 'Usando el Node.js privado {0}'
      StepNode       = 'descargar Node.js {0} de nodejs.org, verificar su SHA-256 y descomprimirlo en {1}'
      NodeDownload   = 'No se encontr\u00f3 Node.js 22.16 o posterior. Descargando una copia privada (Node.js {0}, unos 35 MB). No se toca tu sistema.'
      Verify         = 'Verificando la descarga (SHA-256)'
      BadSum         = 'La descarga no coincide con el checksum oficial. No se instal\u00f3 nada. Prob\u00e1 de nuevo m\u00e1s tarde.'
      NoSum          = 'No se pudo leer el checksum oficial de {0}. No se instal\u00f3 nada.'
      ZipUnsafe      = 'El archivo de Node.js tiene una entrada que se descomprimir\u00eda fuera de su carpeta. No se instal\u00f3 nada.'
      Unsupported    = 'Sistema no soportado: {0} {1}. Us\u00e1 la imagen de Docker: {2}'
      NoTool         = 'Falta una herramienta necesaria: {0}. Instal\u00e1 Node.js 22.16 o posterior desde nodejs.org y volv\u00e9 a correr el instalador.'
      StepInstall    = 'instalar {0} con npm en {1} (sin ejecutar scripts de instalaci\u00f3n)'
      Installing     = 'Instalando {0} (puede tardar un minuto)'
      InstallFail    = 'npm no pudo instalar el paquete. Los mensajes de arriba dicen por qu\u00e9 (red, registro o versi\u00f3n).'
      NoCli          = 'El paquete se instal\u00f3 pero falta {0}. El paquete parece roto.'
      StepShims      = 'crear los comandos {0} y {1}'
      Shims          = 'Comandos creados: {0} y {1}'
      ShimForeign    = '{0} existe y no lo cre\u00f3 este instalador. Movelo y volv\u00e9 a correr el instalador.'
      PathHint       = '{0} no est\u00e1 en tu PATH. Para usar msum desde cualquier terminal, ejecut\u00e1 esto una vez (o volv\u00e9 a correr el instalador con -ModifyPath):'
      StepModifyPath = 'agregar {0} al PATH de tu usuario (HKCU\Environment)'
      PathAdded      = 'Se agreg\u00f3 {0} al PATH de tu usuario. Abr\u00ed una terminal nueva para que tenga efecto.'
      PathPresent    = '{0} ya est\u00e1 en el PATH de tu usuario.'
      PathFail       = 'No se pudo editar el PATH de tu usuario. Para usar msum desde cualquier terminal, ejecut\u00e1 esto una vez:'
      StepInit       = 'ejecutar msum init (crea la carpeta de datos y la configuraci\u00f3n; una existente se conserva)'
      StepService    = 'ejecutar msum service install (el daemon arranca cuando inici\u00e1s sesi\u00f3n; sin permisos de administrador)'
      StepOpen       = 'abrir la web con msum open'
      ServiceFail    = 'No se pudo registrar el servicio. Pod\u00e9s correr el daemon a mano con: msum daemon'
      ServiceSkip    = 'Se omiti\u00f3 el servicio (-NoService). Para arrancar el daemon a mano: msum daemon'
      WebNotUp       = 'La web todav\u00eda no arranc\u00f3 (el daemon arranca la pr\u00f3xima vez que inicies sesi\u00f3n). Para arrancarlo ahora ejecut\u00e1 msum daemon en otra terminal y despu\u00e9s: msum open'
      OpenFail       = 'No se pudo abrir un navegador. Abr\u00ed la direcci\u00f3n de arriba a mano.'
      Done           = 'Listo. Siguiente paso: vincul\u00e1 tu WhatsApp desde la web, o ejecut\u00e1: msum link'
      DryHeader      = 'Simulacro: no se cambia nada. El instalador har\u00eda:'
      DryItem        = '  - {0}'
      UnStart        = 'Desinstalando message-summarize de {0}'
      UnService      = 'Quitando el servicio'
      UnNothing      = 'No hay nada para quitar en {0}'
      UnStep         = 'quitar {0}, {1} y {2} (tus datos se conservan)'
      UnDone         = 'Se quit\u00f3 el programa. Tus datos NO se borraron: est\u00e1n en {0}. Borr\u00e1 esa carpeta vos si quer\u00e9s eliminarlos.'
      UnPathRemoved  = 'Se quit\u00f3 {0} del PATH de tu usuario.'
      UnCancel       = 'Cancelado.'
      UnKeep         = 'Tus datos no se tocaron: {0}'
      Confirm        = '\u00bfContinuar? [S/n] '
      BadArg         = 'Valor de opci\u00f3n inv\u00e1lido: {0}'
      BadVersion     = '-Version inv\u00e1lida: {0}'
      BadTarball     = 'No se puede usar -Tarball {0}: tiene que ser un archivo existente o una URL https://.'
      BadPrefix      = 'Me niego a usar {0} como carpeta de instalaci\u00f3n: {1}'
      PrefixNotOurs  = 'no est\u00e1 vac\u00eda y no la cre\u00f3 este instalador'
      PrefixData     = 'contiene tu carpeta de datos ({0})'
      PrefixUnsafe   = 'es demasiado amplia'
      PrefixChars    = 'su ruta tiene un car\u00e1cter que los comandos no pueden guardar (un signo de porcentaje o una comilla doble)'
      NoHome         = 'USERPROFILE no apunta a una carpeta existente.'
      PrefixInData   = 'est\u00e1 dentro de tu carpeta de datos ({0})'
      InitFail       = 'msum init fall\u00f3 (mir\u00e1 arriba). El programa qued\u00f3 instalado; volv\u00e9 a ejecutar msum init cuando se arregle el problema.'
      DownloadFail   = 'No se pudo descargar {0}. No se instal\u00f3 nada. Revis\u00e1 tu conexi\u00f3n y prob\u00e1 de nuevo.'
      UnSvcFail      = 'No se pudo quitar el servicio (mir\u00e1 arriba). No se borr\u00f3 nada. Arregl\u00e1 eso y volv\u00e9 a correr el desinstalador.'
      UnManual       = 'Se quitaron los archivos del programa, pero el servicio en segundo plano sigue registrado y su programa ya no est\u00e1. Quitalo a mano (en PowerShell):'
      Abort          = 'Interrumpido.'
      Waiting        = 'Esperando que arranque la web'
      StopDaemon     = 'Deteniendo el daemon que est\u00e1 corriendo'
      DaemonStart    = 'Iniciando el daemon'
      UnLocked       = 'No se pudo apartar {0}: un archivo de adentro est\u00e1 en uso (el daemon o una terminal con msum). No se borr\u00f3 nada. Cerralos y volv\u00e9 a correr el desinstalador.'
      UnLeft         = 'El programa se quit\u00f3, pero esta carpeta no se pudo borrar por completo: {0}. Borrala vos cuando nada la use.'
      InstallLocked  = 'No se pudo reemplazar la instalaci\u00f3n anterior porque un archivo est\u00e1 en uso (el daemon o una terminal con msum). Cerralos y volv\u00e9 a correr el instalador. Se conserv\u00f3 la versi\u00f3n anterior.'
      Help           = 'Uso: .\install.ps1 [-Version <v>] [-Tarball <archivo|url>] [-Prefix <carpeta>] [-NoService] [-NoOpen] [-ModifyPath] [-Uninstall] [-DryRun] [-Yes]'
    }
    $decoded = @{}
    foreach ($key in $es.Keys) {
      $decoded[$key] = [regex]::Replace($es[$key], '\\u([0-9a-fA-F]{4})', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) })
    }
    return $decoded
  }

  $lang = $env:MSUM_LANG
  if ([string]::IsNullOrWhiteSpace($lang)) {
    try { $lang = (Get-UICulture).Name } catch { $lang = 'en' }
  }
  if ($lang -like 'es*') { $M = MessagesEs } else { $M = MessagesEn }

  function T([string]$Key) {
    if ($args.Count -eq 0) { return $M[$Key] }
    return [string]::Format($M[$Key], [object[]]$args)
  }
  function Say([string]$Key) { Write-Host (T $Key @args) }
  function Warn([string]$Key) { [Console]::Error.WriteLine((T $Key @args)) }

  # Stop-Msum <exit code> <message key> [args]: the one way out on a failure (the finally of the caller cleans up).
  function Stop-Msum([int]$Code, [string]$Key) {
    $ex = New-Object System.Exception((T $Key @args))
    $ex.Data['MsumExit'] = $Code
    throw $ex
  }

  # ---- environment, options ----------------------------------------------------------------------------------------

  function EnvOn([string]$Name) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $v) { return $false }
    return @('1', 'true', 'yes') -contains $v.Trim().ToLowerInvariant()
  }
  function EnvText([string]$Name) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $v) { return '' }
    return $v.Trim()
  }

  function Get-Abs([string]$Path) {
    $p = $Path
    if (-not [System.IO.Path]::IsPathRooted($p)) {
      $p = [System.IO.Path]::Combine((Get-Location).ProviderPath, $p)
    }
    $full = [System.IO.Path]::GetFullPath($p)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char]'\', [char]'/') }
    return $full
  }

  # True when $Child is $Parent or inside it (by text, case-insensitive: Windows paths).
  function Test-Inside([string]$Child, [string]$Parent) {
    $c = $Child.TrimEnd([char]'\', [char]'/') + $Sep
    $p = $Parent.TrimEnd([char]'\', [char]'/') + $Sep
    return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
  }
  function Test-Same([string]$A, [string]$B) {
    return [string]::Equals($A.TrimEnd([char]'\', [char]'/'), $B.TrimEnd([char]'\', [char]'/'), [System.StringComparison]::OrdinalIgnoreCase)
  }

  # Symbolic links and junctions resolved for the part that exists, the rest kept as written.
  function Get-Physical([string]$Path, [int]$Depth = 0) {
    $full = Get-Abs $Path
    if ($Depth -gt 8) { return $full }
    $root = [System.IO.Path]::GetPathRoot($full)
    $rest = $full.Substring($root.Length)
    $current = $root
    $exists = $true
    foreach ($part in ($rest -split '[\\/]')) {
      if ($part -eq '') { continue }
      $next = [System.IO.Path]::Combine($current, $part)
      if ($exists -and (Test-Path -LiteralPath $next -PathType Container)) {
        $item = Get-Item -LiteralPath $next -Force
        $target = $null
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          $prop = $item.PSObject.Properties['Target']
          if ($null -ne $prop -and $null -ne $prop.Value) { $target = @($prop.Value)[0] }
        }
        if ($null -ne $target -and [string]$target -ne '') {
          $t = [string]$target
          if (-not [System.IO.Path]::IsPathRooted($t)) { $t = [System.IO.Path]::Combine($current, $t) }
          $current = Get-Physical $t ($Depth + 1)
        } else {
          $current = $next
        }
      } else {
        $exists = $false
        $current = $next
      }
    }
    return $current
  }

  function Get-HomeDir {
    $h = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($h) -or -not (Test-Path -LiteralPath $h -PathType Container)) {
      try { $h = [Environment]::GetFolderPath('UserProfile') } catch { $h = '' }
    }
    if ([string]::IsNullOrWhiteSpace($h) -or -not (Test-Path -LiteralPath $h -PathType Container)) {
      Stop-Msum 1 'NoHome'
    }
    return (Get-Abs $h)
  }

  # The data folder, as the program itself resolves it (src/main/installation/paths.ts): MSUM_DATA_DIR unless it is blank (relative
  # paths are resolved), else %APPDATA%\message-summarize. The installer never touches it.
  function Get-DataDir {
    $explicit = $env:MSUM_DATA_DIR
    if (-not [string]::IsNullOrWhiteSpace($explicit)) { return (Get-Abs $explicit) }
    $appdata = $env:APPDATA
    if ([string]::IsNullOrEmpty($appdata)) {
      $appdata = [System.IO.Path]::Combine([System.IO.Path]::Combine($HomeDir, 'AppData'), 'Roaming')
    }
    return (Get-Abs ([System.IO.Path]::Combine($appdata, 'message-summarize')))
  }

  # Refuses a prefix that could destroy something that is not ours: a broad folder, the data folder, a folder that
  # contains it or is inside it (compared by physical path, so links and relative paths do not hide it), or a folder
  # with other things in it.
  function Test-Prefix {
    if ($Prefix.Contains('%') -or $Prefix.Contains('"')) { Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixChars') }
    $pp = Get-Physical $Prefix
    $homePhysical = Get-Physical $HomeDir
    $local = $LocalAppData
    $broad = @(@(
      $HomeDir, $homePhysical, $local,
      [System.IO.Path]::Combine($HomeDir, 'AppData'),
      [System.IO.Path]::Combine([System.IO.Path]::Combine($HomeDir, 'AppData'), 'Roaming'),
      [System.IO.Path]::Combine($HomeDir, 'Desktop'),
      [System.IO.Path]::Combine($HomeDir, 'Documents'),
      [System.IO.Path]::Combine($HomeDir, 'Downloads'),
      $env:APPDATA, $env:SystemRoot, $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:TEMP, $env:TMP
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($candidate in @($Prefix, $pp)) {
      $root = [System.IO.Path]::GetPathRoot($candidate)
      if (Test-Same $candidate $root) { Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixUnsafe') }
      # The home folder is inside the prefix (it is a parent of it, such as C:\Users).
      if (Test-Inside $homePhysical $candidate) { Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixUnsafe') }
      foreach ($folder in $broad) {
        if (Test-Same $candidate (Get-Abs $folder)) { Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixUnsafe') }
      }
    }
    $data = Get-DataDir
    $dp = Get-Physical $data
    foreach ($pair in @(@($Prefix, $data), @($pp, $dp))) {
      if (Test-Inside $pair[1] $pair[0]) { Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixData' $data) }
      if (Test-Inside $pair[0] $pair[1]) { Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixInData' $data) }
    }
    if (Test-Path -LiteralPath $Prefix) {
      $marked = Test-Path -LiteralPath ([System.IO.Path]::Combine($Prefix, $PrefixMarker)) -PathType Leaf
      if (-not $marked) {
        $isDir = Test-Path -LiteralPath $Prefix -PathType Container
        if (-not $isDir -or @(Get-ChildItem -LiteralPath $Prefix -Force -ErrorAction SilentlyContinue).Count -gt 0) {
          Stop-Msum 1 'BadPrefix' $Prefix (T 'PrefixNotOurs')
        }
      }
    }
  }

  function Confirm-Run {
    if ($Yes -or $DryRun -or -not $S.Interactive) { return }
    Write-Host (T 'Confirm') -NoNewline
    $answer = [string](Read-Host)
    $answer = $answer.Trim().ToLowerInvariant()
    $si = 's' + [string][char]0x00ED
    if (@('', 'y', 'yes', 's', 'si', $si) -contains $answer) { return }
    Say 'UnCancel'
    $ex = New-Object System.Exception('cancelled')
    $ex.Data['MsumExit'] = 1
    $ex.Data['MsumQuiet'] = $true
    throw $ex
  }

  # ---- helpers -----------------------------------------------------------------------------------------------------

  # The shim is read and written in the OEM code page, which is the one cmd.exe reads a batch file in.
  function Get-ShimEncoding {
    try {
      $cp = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
      return [System.Text.Encoding]::GetEncoding($cp)
    } catch {
      return (New-Object System.Text.UTF8Encoding($false))
    }
  }

  # True when a path can be written inside a .cmd shim as it is: no percent sign or quote, and every character exists
  # in the OEM code page that cmd.exe reads the file in.
  function Test-ShimSafe([string]$Path) {
    if ($Path.Contains('%') -or $Path.Contains('"')) { return $false }
    $encoding = Get-ShimEncoding
    try { return ($encoding.GetString($encoding.GetBytes($Path)) -ceq $Path) } catch { return $false }
  }

  function Invoke-Native([string]$File, [string[]]$Arguments) {
    & $File @Arguments | Out-Host
    return $LASTEXITCODE
  }

  # Runs a block again after a short pause when it fails: antivirus and indexers hold files for a moment on Windows.
  function Invoke-Retry([scriptblock]$Action) {
    $tries = 0
    while ($true) {
      try {
        & $Action
        return
      } catch {
        $tries++
        if ($tries -ge 5) { throw }
        Start-Sleep -Milliseconds (300 * $tries)
      }
    }
  }

  # Deletes directory links (junctions, symbolic links) below a folder WITHOUT following them, so that a recursive
  # delete never walks into (and empties) the target of a link. Windows PowerShell 5.1 follows junctions otherwise.
  function Remove-Links([string]$Dir) {
    foreach ($sub in [System.IO.Directory]::GetDirectories($Dir)) {
      if (([System.IO.File]::GetAttributes($sub) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        (New-Object System.IO.DirectoryInfo($sub)).Delete()
      } else {
        Remove-Links $sub
      }
    }
  }

  # Deletes a file or a folder tree, links first (see Remove-Links), with a short retry. Throws when it cannot.
  function Remove-Tree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
      Invoke-Retry { Remove-Item -LiteralPath $Path -Force }
      return
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Invoke-Retry { (New-Object System.IO.DirectoryInfo($Path)).Delete() }
      return
    }
    $linksGone = $true
    try { Invoke-Retry { Remove-Links $Path } } catch { $linksGone = $false }
    if ($linksGone) {
      try {
        Invoke-Retry { Remove-Item -LiteralPath $Path -Recurse -Force }
        return
      } catch { }
    }
    # Paths longer than 260 characters (node_modules) can defeat PowerShell 5.1; rmdir does not follow links either.
    try {
      $null = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /c rmdir /s /q "' + $Path + '"') -Wait -WindowStyle Hidden
    } catch { }
    if (Test-Path -LiteralPath $Path) { throw (New-Object System.IO.IOException('could not delete ' + $Path)) }
  }

  function Get-RunValue {
    try {
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunKeyPath)
      if ($null -eq $key) { return $null }
      try { return $key.GetValue($RunValue) } finally { $key.Close() }
    } catch { return $null }
  }

  # The launcher the Run value names (the data folder may have changed since), else the usual place.
  function Get-LauncherPath {
    $launcher = [System.IO.Path]::Combine((Get-DataDir), $LauncherName)
    $value = Get-RunValue
    if ($null -ne $value) {
      $m = [regex]::Match([string]$value, '-File "([^"]+)"')
      if ($m.Success -and [System.IO.Path]::GetFileName($m.Groups[1].Value) -eq $LauncherName) { $launcher = $m.Groups[1].Value }
    }
    return $launcher
  }

  # Stops the daemon of this installation, and the launcher loop that would start it again. A daemon is a node.exe
  # that runs from the private Node.js (under the prefix) or has the program of this prefix on its command line.
  # Returns true when something was running. Never fails: without CIM (or without rights) it just finds nothing.
  function Stop-Daemon([string]$CliPath) {
    $found = $false
    $processes = @()
    try {
      $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in @('node.exe', 'powershell.exe', 'pwsh.exe') })
    } catch { return $false }
    $launcherHint = [System.IO.Path]::Combine((Get-DataDir), $LauncherName)
    $victims = @()
    # The launchers first, or one of them would bring the daemon back.
    foreach ($p in $processes) {
      $line = [string]$p.CommandLine
      if ($p.Name -ne 'node.exe' -and $line.IndexOf($LauncherName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ($line.IndexOf($launcherHint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $line.IndexOf((Get-LauncherPath), [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        $victims += $p
      }
    }
    foreach ($p in $processes) {
      if ($p.Name -ne 'node.exe') { continue }
      $line = [string]$p.CommandLine
      $exe = [string]$p.ExecutablePath
      $underPrefix = ($exe -ne '' -and (Test-Inside $exe $Prefix))
      $runsCli = ($CliPath -ne '' -and $line.IndexOf($CliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
      if ($underPrefix -or $runsCli) { $victims += $p }
    }
    $own = $PID
    foreach ($p in $victims) {
      if ([int]$p.ProcessId -eq $own) { continue }
      if (-not $found) { Say 'StopDaemon' }
      $found = $true
      try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop } catch { }
    }
    if ($found) {
      foreach ($p in $victims) { Wait-Process -Id ([int]$p.ProcessId) -Timeout 10 -ErrorAction SilentlyContinue }
    }
    return $found
  }

  # Starts the launcher of the daemon hidden, the same way the Run key does at sign-in (Execution policy bypass for
  # that one process only). A failure only means the daemon starts at the next sign-in.
  function Start-Daemon([string]$Launcher) {
    try {
      Say 'DaemonStart'
      $exe = 'powershell.exe'
      if (-not [string]::IsNullOrEmpty($env:SystemRoot)) {
        $candidate = [System.IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\powershell.exe')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $exe = $candidate }
      }
      $null = Start-Process -FilePath $exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Launcher + '"') -WindowStyle Hidden
    } catch { }
  }

  # The version of a node.exe when it is recent enough (22.16 or later), else nothing.
  function Get-NodeReport([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = ''
    try { $text = (& $Path -v 2>&1 | Out-String).Trim() } catch { $text = '' } finally { $ErrorActionPreference = $old }
    $m = [regex]::Match($text, '^v(\d+)\.(\d+)\.(\d+)$')
    if (-not $m.Success) { return $null }
    $major = [int]$m.Groups[1].Value
    $minor = [int]$m.Groups[2].Value
    if ($major -gt $NodeMinMajor -or ($major -eq $NodeMinMajor -and $minor -ge $NodeMinMinor)) { return $text }
    return $null
  }

  # Finds the node to use: sets $S.NodeBin and $S.NodeNeedsDownload.
  function Select-Node {
    $S.NodeBin = ''
    $S.NodeNeedsDownload = $false
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmd) {
      $candidate = [string]$cmd.Source
      $nv = $null
      # A node whose path the shim cannot hold (a percent sign, a quote, characters the OEM code page lacks) is not
      # used: the private copy is, and its shims hold no path at all.
      if (Test-ShimSafe $candidate) { $nv = Get-NodeReport $candidate }
      if ($null -ne $nv) {
        $S.NodeBin = $candidate
        Say 'NodeFound' $nv $candidate
        return
      }
    }
    $privateNode = [System.IO.Path]::Combine([System.IO.Path]::Combine($Prefix, 'node'), 'node.exe')
    $nv = Get-NodeReport $privateNode
    if ($null -ne $nv) {
      $S.NodeBin = $privateNode
      Say 'NodePrivate' $nv
      return
    }
    $S.NodeNeedsDownload = $true
    $S.NodeBin = $privateNode
  }

  # The name of the official build for this machine, or a stop with a clear message. Only x64 is served: the
  # dependencies of the package are not checked on ARM64 Windows.
  function Get-NodeTarget {
    $onWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
    $arch = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ([string]::IsNullOrEmpty($arch)) { $arch = 'unknown' }
    if (-not $onWindows) { Stop-Msum 3 'Unsupported' ([System.Environment]::OSVersion.Platform.ToString()) $arch $DockerUrl }
    if ($arch -eq 'AMD64') { return 'win-x64' }
    Stop-Msum 3 'Unsupported' 'Windows' $arch $DockerUrl
  }

  function Get-Remote([string]$Url, [string]$Destination) {
    if (-not $Url.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Msum 1 'BadTarball' $Url }
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
  }

  function Install-Node {
    $target = Get-NodeTarget
    Say 'NodeDownload' $NodeVersion
    $name = "node-v$NodeVersion-$target"
    $zipName = "$name.zip"
    $base = "$NodeDist/v$NodeVersion"
    $sums = [System.IO.Path]::Combine($S.Tmp, 'SHASUMS256.txt')
    $zip = [System.IO.Path]::Combine($S.Tmp, $zipName)
    try { Get-Remote "$base/SHASUMS256.txt" $sums } catch { Stop-Msum 1 'DownloadFail' 'SHASUMS256.txt' }
    $expected = ''
    foreach ($line in (Get-Content -LiteralPath $sums)) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -ceq $zipName) { $expected = $parts[0].ToLowerInvariant(); break }
    }
    if ($expected -notmatch '^[0-9a-f]{64}$') { Stop-Msum 1 'NoSum' $zipName }
    try { Get-Remote "$base/$zipName" $zip } catch { Stop-Msum 1 'DownloadFail' $zipName }
    Say 'Verify'
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Stop-Msum 5 'BadSum' }
    # Only a verified archive is opened. Every entry must land inside the extraction folder (zip-slip).
    $extract = [System.IO.Path]::Combine($S.Tmp, 'extract')
    $null = New-Item -ItemType Directory -Path $extract -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
      foreach ($entry in $archive.Entries) {
        $resolved = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($extract, $entry.FullName))
        if (-not (Test-Inside $resolved $extract)) { Stop-Msum 1 'ZipUnsafe' }
      }
    } finally {
      $archive.Dispose()
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $unpacked = [System.IO.Path]::Combine($extract, $name)
    if (-not (Test-Path -LiteralPath ([System.IO.Path]::Combine($unpacked, 'node.exe')) -PathType Leaf)) { Stop-Msum 1 'DownloadFail' $zipName }
    $nodeNew = [System.IO.Path]::Combine($Prefix, 'node.new')
    $nodeDir = [System.IO.Path]::Combine($Prefix, 'node')
    if (Test-Path -LiteralPath $nodeNew) { Remove-Tree $nodeNew }
    Invoke-Retry { Move-Item -LiteralPath $unpacked -Destination $nodeNew }
    if (Test-Path -LiteralPath $nodeDir) { Remove-Tree $nodeDir }
    Invoke-Retry { Move-Item -LiteralPath $nodeNew -Destination $nodeDir }
  }

  # Writes a shim. With a private Node.js (an empty $Node) the shim holds no absolute path at all: it finds node and the
  # program relative to its own folder (%~dp0, <prefix>\bin), so a profile folder with accents works whatever the code
  # page. With a system Node.js, only that one path is written (in the OEM code page).
  function Write-Shim([string]$Path, [string]$Node) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $cliRelative = '"%~dp0..\node_modules\' + $PackageName + '\dist\main\cli.js"'
    if ($Node -eq '') {
      $lines = @(
        '@echo off',
        $ShimMark,
        'if not exist "%~dp0..\node\node.exe" goto missing',
        ('"%~dp0..\node\node.exe" ' + $cliRelative + ' %*'),
        'exit /b %ERRORLEVEL%',
        ':missing',
        'echo message-summarize: Node.js not found in "%~dp0..\node". Run the installer again. 1>&2',
        'exit /b 1'
      )
    } else {
      if (-not (Test-ShimSafe $Node)) { Stop-Msum 1 'BadPrefix' $Node (T 'PrefixChars') }
      $encoding = Get-ShimEncoding
      $lines = @(
        '@echo off',
        $ShimMark,
        "set `"NODE=$Node`"",
        'if not exist "%NODE%" goto missing',
        ('"%NODE%" ' + $cliRelative + ' %*'),
        'exit /b %ERRORLEVEL%',
        ':missing',
        'echo message-summarize: Node.js not found at "%NODE%". Run the installer again. 1>&2',
        'exit /b 1'
      )
    }
    if (Test-Path -LiteralPath $Path) {
      if (-not (Test-ShimOurs $Path)) { Stop-Msum 1 'ShimForeign' $Path }
    }
    $tmpShim = [System.IO.Path]::Combine($S.Tmp, [System.IO.Path]::GetFileName($Path) + '.new')
    [System.IO.File]::WriteAllText($tmpShim, (($lines -join "`r`n") + "`r`n"), $encoding)
    Invoke-Retry { Move-Item -LiteralPath $tmpShim -Destination $Path -Force }
  }

  # A value the installer wrote into a marked shim (nothing when it cannot be read back).
  function Get-ShimValue([string]$Name, [string]$Path) {
    try {
      $text = [System.IO.File]::ReadAllText($Path, (Get-ShimEncoding))
    } catch { return '' }
    $m = [regex]::Match($text, '(?m)^set "' + $Name + '=([^"\r\n]*)"\s*$')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
  }

  function Test-ShimOurs([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try { return ([System.IO.File]::ReadAllText($Path)).Contains($ShimMark) } catch { return $false }
  }

  # What a marked shim belongs to: its prefix (the folder above its own bin folder), the node it runs and the program.
  # Shims of the first version of this script held absolute `set "CLI=..."` and `set "NODE=..."` lines: still read.
  function Get-ShimTargets([string]$Shim) {
    $shimPrefix = ''
    $cli = Get-ShimValue 'CLI' $Shim
    $node = Get-ShimValue 'NODE' $Shim
    $suffix = "\node_modules\$PackageName\dist\main\cli.js"
    if ($cli -ne '') {
      if ($cli.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase) -and $cli.Length -gt $suffix.Length) {
        $shimPrefix = $cli.Substring(0, $cli.Length - $suffix.Length)
      }
    } else {
      $binFolder = [System.IO.Path]::GetDirectoryName($Shim)
      if ($null -ne $binFolder -and [System.IO.Path]::GetFileName($binFolder) -ieq 'bin') {
        $shimPrefix = [System.IO.Path]::GetDirectoryName($binFolder)
        if ($null -eq $shimPrefix) { $shimPrefix = '' }
        if ($shimPrefix -ne '') { $cli = [System.IO.Path]::Combine($shimPrefix, $suffix.TrimStart([char]'\')) }
      }
    }
    if ($node -eq '' -and $shimPrefix -ne '') { $node = [System.IO.Path]::Combine([System.IO.Path]::Combine($shimPrefix, 'node'), 'node.exe') }
    return @{ Prefix = $shimPrefix; Node = $node; Cli = $cli }
  }

  # ---- PATH (HKCU only) --------------------------------------------------------------------------------------------

  function Get-PathEntries([string]$Value) {
    return @($Value -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  function Test-EntryIsBin([string]$Entry) {
    $e = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"'))
    try { $e = Get-Abs $e } catch { return $false }
    return (Test-Same $e $BinDir)
  }
  function Test-OnPath {
    foreach ($entry in (Get-PathEntries ([string]$env:Path))) {
      if (Test-EntryIsBin $entry) { return $true }
    }
    return $false
  }
  # The command to print when the PATH is not edited. It edits the registry value as it is (SetEnvironmentVariable would
  # freeze the %VARIABLES% of the current PATH), and a single quote in the folder is doubled.
  function PathCommand {
    $quoted = $BinDir.Replace("'", "''")
    return "`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', `$true); `$p = [string]`$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); if (`$p) { `$p = `$p.TrimEnd(';') + ';' }; `$k.SetValue('Path', `$p + '$quoted', 'ExpandString'); `$k.Close()"
  }

  # Tells the running programs (Explorer, new terminals) that the environment changed. Best effort: a failure here is
  # not a failure of the install, the PATH is in the registry either way.
  function Send-EnvironmentChange {
    try {
      if (-not ('MsumWin.Native' -as [type])) {
        Add-Type -Namespace MsumWin -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      }
      $result = [UIntPtr]::Zero
      $null = [MsumWin.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    } catch { }
  }

  # Reads the user PATH without expanding %VARIABLES%, so writing it back does not freeze them.
  function Open-UserEnvKey { return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true) }

  function Add-UserPath {
    $key = Open-UserEnvKey
    try {
      $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      try { $kind = $key.GetValueKind('Path') } catch { }
      foreach ($entry in (Get-PathEntries $current)) {
        if (Test-EntryIsBin $entry) { Say 'PathPresent' $BinDir; return }
      }
      $new = $BinDir
      if (-not [string]::IsNullOrWhiteSpace($current)) { $new = $current.TrimEnd(';') + ';' + $BinDir }
      $key.SetValue('Path', $new, $kind)
    } finally {
      $key.Close()
    }
    Send-EnvironmentChange
    Say 'PathAdded' $BinDir
  }

  function Remove-UserPath {
    try {
      $key = Open-UserEnvKey
    } catch { return }
    if ($null -eq $key) { return }
    $changed = $false
    try {
      $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = Get-PathEntries $current
      $kept = @($entries | Where-Object { -not (Test-EntryIsBin $_) })
      if ($kept.Count -ne $entries.Count) {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        try { $kind = $key.GetValueKind('Path') } catch { }
        $key.SetValue('Path', ($kept -join ';'), $kind)
        $changed = $true
      }
    } finally {
      $key.Close()
    }
    if ($changed) {
      Send-EnvironmentChange
      Say 'UnPathRemoved' $BinDir
    }
  }

  # ---- uninstall ---------------------------------------------------------------------------------------------------

  # What a background service needs removed by hand if its program is gone: the exact commands, or nothing when no
  # service is registered. The names are the ones of src/infrastructure/service/windows-run-key.ts.
  function Get-ServiceLeftover {
    if ($null -eq (Get-RunValue)) { return @() }
    $launcher = Get-LauncherPath
    return @(
      "reg delete `"HKCU\$RunKeyPath`" /v $RunValue /f",
      "Remove-Item -LiteralPath `"$launcher`""
    )
  }

  function Invoke-Uninstall {
    # The shim says which program (and prefix) it belongs to; an explicit -Prefix wins.
    $shim = ''
    foreach ($candidate in @($ShimMsum, $ShimLong)) {
      if ($shim -eq '' -and (Test-ShimOurs $candidate)) { $shim = $candidate }
    }
    if ($shim -eq '') {
      $found = Get-Command 'msum.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -ne $found -and (Test-ShimOurs ([string]$found.Source))) { $shim = [string]$found.Source }
    }
    $shimCli = ''
    $shimNode = ''
    if ($shim -ne '') {
      $targets = Get-ShimTargets $shim
      $shimCli = $targets.Cli
      $shimNode = $targets.Node
      if (-not $S.PrefixGiven -and $targets.Prefix -ne '') {
        Set-Variable -Name Prefix -Value (Get-Abs $targets.Prefix) -Scope 1
      }
    }
    Test-Prefix
    Set-Variable -Name BinDir -Value ([System.IO.Path]::Combine($Prefix, 'bin')) -Scope 1
    $data = Get-DataDir
    Say 'UnStart' $Prefix
    $msumShim = [System.IO.Path]::Combine($BinDir, 'msum.cmd')
    $longShim = [System.IO.Path]::Combine($BinDir, 'message-summarize.cmd')
    if ($DryRun) {
      Say 'DryHeader'
      Say 'DryItem' 'msum service uninstall'
      Say 'DryItem' (T 'UnStep' $Prefix $msumShim $longShim)
      Say 'UnDone' $data
      return
    }
    $present = (Test-Path -LiteralPath $Prefix) -or ($shim -ne '')
    if (-not $present) {
      Say 'UnNothing' $Prefix
      Say 'UnDone' $data
      return
    }
    Confirm-Run
    $manual = @()
    if ($shimCli -ne '' -and (Test-Path -LiteralPath $shimCli -PathType Leaf) -and $shimNode -ne '' -and (Test-Path -LiteralPath $shimNode -PathType Leaf)) {
      Say 'UnService'
      # Nothing is deleted when the service cannot be removed: the program that knows how is still there for a retry.
      $code = Invoke-Native $shimNode @($shimCli, 'service', 'uninstall')
      if ($code -ne 0) { Stop-Msum 1 'UnSvcFail' }
    } else {
      $manual = Get-ServiceLeftover
    }
    # The daemon (and the launcher that would bring it back) must be gone before anything is deleted: on Windows a
    # running node.exe holds its own files.
    $null = Stop-Daemon $shimCli
    # Deleting is made in an order that cannot leave a half-removed program: the prefix (where the shims live) is first
    # moved aside in one step, which fails, changing nothing, while a file in it is in use. Only then the PATH entry is
    # removed and the moved folder deleted.
    $leftover = ''
    if (Test-Path -LiteralPath $Prefix -PathType Container) {
      # Only a folder the installer created (it holds the marker) or an empty one; Test-Prefix has checked that.
      $moved = $Prefix + '.removing-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
      try {
        Invoke-Retry { Move-Item -LiteralPath $Prefix -Destination $moved }
      } catch {
        Stop-Msum 1 'UnLocked' $Prefix
      }
      $leftover = $moved
    }
    foreach ($candidate in @($ShimMsum, $ShimLong)) {
      if (Test-ShimOurs $candidate) { Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue }
    }
    Remove-UserPath
    if ($leftover -ne '') {
      try { Remove-Tree $leftover } catch {
        Warn 'UnLeft' $leftover
        $S.ExitCode = 1
      }
    }
    if ($manual.Count -gt 0) {
      Say 'UnManual'
      foreach ($line in $manual) { Write-Host ('  ' + $line) }
      Say 'UnKeep' $data
      if ($S.ExitCode -eq 0) { $S.ExitCode = 6 }
    } elseif ($S.ExitCode -ne 0) {
      Say 'UnKeep' $data
    } else {
      Say 'UnDone' $data
    }
  }

  # ---- install -----------------------------------------------------------------------------------------------------

  function Invoke-Install {
    Test-Prefix

    $packageSpec = ''
    $remoteTarball = $false
    if ($Tarball -eq '') {
      $packageSpec = "$PackageName@$Version"
    } elseif ($Tarball.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
      $remoteTarball = $true
    } elseif ($Tarball -match '^[A-Za-z][A-Za-z0-9+.-]+://') {
      Stop-Msum 1 'BadTarball' $Tarball
    } else {
      if (-not (Test-Path -LiteralPath $Tarball -PathType Leaf)) { Stop-Msum 1 'BadTarball' $Tarball }
      $packageSpec = Get-Abs $Tarball
    }

    Say 'Start' $Prefix
    Select-Node
    if ($S.NodeNeedsDownload) {
      $null = Get-NodeTarget # fails early, also in a dry run, on a system the download cannot serve
    }

    if ($DryRun) {
      Say 'DryHeader'
      if ($S.NodeNeedsDownload) {
        Say 'DryItem' (T 'StepNode' $NodeVersion ([System.IO.Path]::Combine($Prefix, 'node')))
      }
      if ($Tarball -ne '') {
        Say 'DryItem' (T 'StepInstall' $Tarball $Prefix)
      } else {
        Say 'DryItem' (T 'StepInstall' "$PackageName@$Version" $Prefix)
      }
      Say 'DryItem' (T 'StepShims' $ShimMsum $ShimLong)
      if (Test-OnPath) {
        # nothing to do
      } elseif ($ModifyPath) {
        Say 'DryItem' (T 'StepModifyPath' $BinDir)
      } else {
        Say 'PathHint' $BinDir
        Write-Host ('  ' + (PathCommand))
      }
      Say 'DryItem' $M.StepInit
      if (-not $NoService) { Say 'DryItem' $M.StepService }
      if (-not $NoOpen) { Say 'DryItem' $M.StepOpen }
      return
    }

    Confirm-Run

    $null = New-Item -ItemType Directory -Path $Prefix -Force
    $null = New-Item -ItemType File -Path ([System.IO.Path]::Combine($Prefix, $PrefixMarker)) -Force
    $null = New-Item -ItemType Directory -Path $BinDir -Force
    $S.Tmp = [System.IO.Path]::Combine($Prefix, '.tmp-install-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $S.Tmp -Force

    # An upgrade: the daemon of the previous version holds its files, so it is stopped (with its launcher) and started
    # again at the end. A fresh install finds nothing to stop.
    $cli = [System.IO.Path]::Combine($Prefix, 'node_modules\' + $PackageName + '\dist\main\cli.js')
    $daemonWasRunning = Stop-Daemon $cli

    if ($S.NodeNeedsDownload) { Install-Node }

    if ($remoteTarball) {
      $downloaded = [System.IO.Path]::Combine($S.Tmp, 'package.tgz')
      try { Get-Remote $Tarball $downloaded } catch { Stop-Msum 1 'BadTarball' $Tarball }
      $packageSpec = $downloaded
    }

    # npm sits next to node (the private copy, or the system one).
    $nodeDir = [System.IO.Path]::GetDirectoryName($S.NodeBin)
    $npm = [System.IO.Path]::Combine($nodeDir, 'npm.cmd')
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
      $found = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -eq $found) { Stop-Msum 4 'NoTool' 'npm' }
      $npm = [string]$found.Source
    }

    # --ignore-scripts: the package has no install scripts of its own, Baileys' preinstall is only an engine check (the
    # installer already checked the Node.js version) and protobufjs' postinstall only prints a warning. Not running
    # third-party scripts is the safer choice. --no-save: a tarball in a temporary file must not stay in the manifest,
    # and a rerun resolves the version again. An upgrade is a clean install; the previous tree is kept aside and put
    # back if the new one cannot be installed (see the finally of the caller). No --install-links: the package declares
    # "sharp": "file:vendor/sharp-stub" and with that flag npm looks for the stub next to the tarball instead of inside
    # it (ENOENT/ENOTDIR on every OS). Without it npm makes a link (a junction on Windows, no privileges needed), which
    # Remove-Links/Remove-Tree already handle, and it is the same command install.sh runs.
    $modules = [System.IO.Path]::Combine($Prefix, 'node_modules')
    $aside = [System.IO.Path]::Combine($Prefix, 'node_modules.old')
    if (Test-Path -LiteralPath $aside -PathType Container) {
      if (Test-Path -LiteralPath $modules -PathType Container) {
        Remove-Tree $aside
      } else {
        # left by an interrupted run: the only good copy
        try { Invoke-Retry { Move-Item -LiteralPath $aside -Destination $modules } } catch { Stop-Msum 1 'InstallLocked' }
      }
    }
    if (Test-Path -LiteralPath $modules -PathType Container) {
      try { Invoke-Retry { Move-Item -LiteralPath $modules -Destination $aside } } catch { Stop-Msum 1 'InstallLocked' }
      $S.ModulesAside = $true
    }
    if ($Tarball -ne '') { Say 'Installing' $Tarball } else { Say 'Installing' "$PackageName@$Version" }
    $oldPath = $env:Path
    $oldNotifier = $env:npm_config_update_notifier
    $code = 1
    try {
      $env:Path = $nodeDir + ';' + $env:Path
      $env:npm_config_update_notifier = 'false'
      $code = Invoke-Native $npm @('install', '--prefix', $Prefix, '--no-fund', '--no-audit', '--ignore-scripts', '--no-save', '--loglevel=error', $packageSpec)
    } finally {
      $env:Path = $oldPath
      $env:npm_config_update_notifier = $oldNotifier
    }
    if ($code -ne 0) { Stop-Msum 1 'InstallFail' } # the finally of the caller puts the previous node_modules back
    $S.ModulesAside = $false
    if (Test-Path -LiteralPath $aside) { Remove-Tree $aside }

    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { Stop-Msum 1 'NoCli' $cli }

    $shimNode = $S.NodeBin
    if (Test-Inside $S.NodeBin $Prefix) { $shimNode = '' } # the private Node.js: relative shims, no path inside
    Write-Shim $ShimMsum $shimNode
    Write-Shim $ShimLong $shimNode
    Say 'Shims' $ShimMsum $ShimLong

    if (-not (Test-OnPath)) {
      if ($ModifyPath) {
        try {
          Add-UserPath
        } catch {
          Say 'PathFail'
          Write-Host ('  ' + (PathCommand))
        }
      } else {
        Say 'PathHint' $BinDir
        Write-Host ('  ' + (PathCommand))
      }
    }

    # init never asks anything and keeps an existing configuration.
    $code = Invoke-Native $ShimMsum @('init')
    if ($code -ne 0) { Stop-Msum 1 'InitFail' }

    $serviceUp = $false
    if ($NoService) {
      Say 'ServiceSkip'
    } else {
      # msum service install prints its own hints (the daemon starts at the next sign-in).
      $code = Invoke-Native $ShimMsum @('service', 'install')
      if ($code -eq 0) {
        $serviceUp = $true
      } else {
        Warn 'ServiceFail'
        $S.ExitCode = 6
      }
    }

    # The Run key only takes effect at the next sign-in, so the launcher is started now (as the .exe installer does)
    # when the service was registered, or when a daemon was running before this upgrade. -NoService on a fresh install
    # starts nothing. Not when a daemon is already answering.
    $started = $false
    if ($serviceUp -or ($daemonWasRunning -and -not $NoService)) {
      $launcher = Get-LauncherPath
      if ((Test-Path -LiteralPath $launcher -PathType Leaf) -and -not (Test-WebUp)) {
        Start-Daemon $launcher
        $started = $true
      }
    }

    if (-not $NoOpen) {
      # The daemon needs a moment to open the web. `--print` output is discarded so that the token is shown only once,
      # by the real `msum open`.
      $maxTries = 1
      if ($started) { $maxTries = 30; Say 'Waiting' }
      $webUp = $false
      for ($i = 0; $i -lt $maxTries; $i++) {
        if (Test-WebUp) { $webUp = $true; break }
        if ($i + 1 -lt $maxTries) { Start-Sleep -Seconds 1 }
      }
      if ($webUp) {
        $code = Invoke-Native $ShimMsum @('open')
        if ($code -ne 0) { Warn 'OpenFail' }
      } elseif ($serviceUp) {
        Say 'WebNotUp'
      }
    }

    Say 'Done'
  }

  # `msum open --print` with everything it prints thrown away (it prints the token): true when it succeeds.
  function Test-WebUp {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $ShimMsum open --print *> $null
      return ($LASTEXITCODE -eq 0)
    } catch {
      return $false
    } finally {
      $ErrorActionPreference = $old
    }
  }

  # ---- main --------------------------------------------------------------------------------------------------------

  $result = 0
  try {
    if ($Help) {
      Write-Host $M.Help
      return
    }

    # Options: the parameter wins, then the environment variable (a command piped to iex cannot take parameters).
    $PSBound = $PSBoundParameters
    if (-not $PSBound.ContainsKey('Version')) { $Version = EnvText 'MSUM_VERSION' }
    if (-not $PSBound.ContainsKey('Tarball')) { $Tarball = EnvText 'MSUM_TARBALL' }
    if (-not $PSBound.ContainsKey('Prefix')) { $Prefix = EnvText 'MSUM_PREFIX' }
    if (-not $NoService) { $NoService = [switch](EnvOn 'MSUM_NO_SERVICE') }
    if (-not $NoOpen) { $NoOpen = [switch](EnvOn 'MSUM_NO_OPEN') }
    if (-not $ModifyPath) { $ModifyPath = [switch](EnvOn 'MSUM_MODIFY_PATH') }
    if (-not $Uninstall) { $Uninstall = [switch](EnvOn 'MSUM_UNINSTALL') }
    if (-not $DryRun) { $DryRun = [switch](EnvOn 'MSUM_DRY_RUN') }
    if (-not $Yes) { $Yes = [switch](EnvOn 'MSUM_YES') }

    if ([string]::IsNullOrWhiteSpace($Version)) { $Version = 'latest' }
    if ($null -eq $Tarball) { $Tarball = '' }
    if ($Version.StartsWith('-') -or $Version -notmatch '^[A-Za-z0-9._~+-]+$') { Stop-Msum 2 'BadVersion' $Version }
    $Tarball = $Tarball.Trim()

    # Asking is for a person at a terminal who ran the file; a command piped to iex has no file and never asks.
    $S.Interactive = $false
    if (-not [string]::IsNullOrEmpty($ScriptFile)) {
      try { $S.Interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { $S.Interactive = $false }
    }

    $HomeDir = Get-HomeDir
    $LocalAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
      $LocalAppData = [System.IO.Path]::Combine([System.IO.Path]::Combine($HomeDir, 'AppData'), 'Local')
    }
    $LocalAppData = Get-Abs $LocalAppData
    if ([string]::IsNullOrWhiteSpace($Prefix)) {
      $Prefix = [System.IO.Path]::Combine($LocalAppData, 'message-summarize-app')
    } else {
      $S.PrefixGiven = $true
    }
    $Prefix = Get-Abs $Prefix
    $BinDir = [System.IO.Path]::Combine($Prefix, 'bin')
    $ShimMsum = [System.IO.Path]::Combine($BinDir, 'msum.cmd')
    $ShimLong = [System.IO.Path]::Combine($BinDir, 'message-summarize.cmd')

    if ($Uninstall) {
      Invoke-Uninstall
    } else {
      Invoke-Install
    }
    $result = $S.ExitCode
  } catch {
    $ex = $_.Exception
    $code = 1
    $quiet = $false
    $cursor = $ex
    while ($null -ne $cursor) {
      if ($cursor.Data.Contains('MsumExit')) {
        $code = [int]$cursor.Data['MsumExit']
        $quiet = $cursor.Data.Contains('MsumQuiet')
        $ex = $cursor
        break
      }
      $cursor = $cursor.InnerException
    }
    if (-not $quiet) { [Console]::Error.WriteLine($ex.Message) }
    $result = $code
  } finally {
    # An install that stopped half way (error or Ctrl-C) puts the previous working copy back.
    try {
      if ($S.ModulesAside) {
        $modulesPath = [System.IO.Path]::Combine($Prefix, 'node_modules')
        $asidePath = [System.IO.Path]::Combine($Prefix, 'node_modules.old')
        if (Test-Path -LiteralPath $asidePath -PathType Container) {
          if (Test-Path -LiteralPath $modulesPath) { Remove-Tree $modulesPath }
          Invoke-Retry { Move-Item -LiteralPath $asidePath -Destination $modulesPath }
        }
      }
    } catch { }
    try {
      if ($S.Tmp -ne '' -and (Test-Path -LiteralPath $S.Tmp)) { Remove-Tree $S.Tmp }
    } catch { }
  }

  # A file ends with its own exit code; under iex an exit would close the terminal of the person, so only the
  # variable is set.
  if (-not [string]::IsNullOrEmpty($ScriptFile)) { exit $result }
  $global:LASTEXITCODE = $result
}

Invoke-MsumInstaller @PSBoundParameters
