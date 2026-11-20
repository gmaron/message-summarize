<#
.SYNOPSIS
  Builds the Windows installer (Inno Setup) of message-summarize. Runs on windows-latest (PowerShell 5.1 or 7).

.DESCRIPTION
  Two phases, so that the signing secrets never reach third-party build code (npm and its dependencies' scripts):

  -Stage    reads the version from package.json and the pinned Node.js version from install.sh (one place for the
            literal); builds the package; downloads the official Node.js win-x64 zip and VERIFIES its SHA-256 against
            nodejs.org SHASUMS256.txt BEFORE extracting it; stages the payload (private node.exe, and app\ installed
            with `npm ci --omit=dev --ignore-scripts` from package-lock.json, so the exact locked versions), the
            bin\msum.cmd and bin\message-summarize.cmd shims; runs the production license check on the staged tree.
            It removes the signing variables from its environment.
  -Compile  runs iscc on the staged payload (this is the only phase that reads WINDOWS_SIGN_PFX_*; it runs no npm and
            no PATH lookup: ISCC.exe and signtool.exe are taken from fixed Program Files folders), writes
            dist-installer\message-summarize-<version>-win-x64-setup.exe and dist-installer\SHA256SUMS.txt.

  With neither switch both phases run. -WorkDir keeps the staged payload between the two (default: a temporary folder,
  removed at the end of the last phase). Any failing step stops the script with a non-zero exit code.

  Optional signing (skipped when the variables are absent; nothing is ever stored in the repository). Set, from CI
  secrets, for -Compile only: WINDOWS_SIGN_PFX_BASE64 (the .pfx, base64) and WINDOWS_SIGN_PFX_PASSWORD.
  WINDOWS_SIGN_TIMESTAMP_URL overrides the default RFC 3161 timestamp server. The certificate is written to the
  temporary folder only while iscc runs. An unsigned installer makes Windows SmartScreen warn on first run: expected.

.PARAMETER OutDir
  Where the installer and SHA256SUMS.txt go (default: dist-installer in the repository). Only those two files are
  replaced; anything else in the folder is left alone.
#>
[CmdletBinding()]
param(
  [switch]$Stage,
  [switch]$Compile,
  [string]$WorkDir = '',
  [string]$OutDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow in 5.1 with the progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

if (-not $Stage -and -not $Compile) { $Stage = $true; $Compile = $true }
$keepWork = $Stage -and -not $Compile

$repo = Split-Path -Parent $PSScriptRoot
if ($OutDir -eq '') { $OutDir = Join-Path $repo 'dist-installer' }

function Invoke-Native {
  # Runs a program and fails when it does not exit with 0 (PowerShell does not do that on its own).
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }
}

function Write-TextFile {
  # UTF-8 without BOM; the caller puts the line endings in the text.
  param([string]$Path, [string]$Text)
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Convert-LinksToCopies {
  # The installer copies files, not junctions: a linked dependency (the vendored sharp stub) becomes a real copy.
  param([string]$Root)
  $links = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -Directory | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  foreach ($link in $links) {
    $target = $link.Target
    if ($target -is [array]) { $target = $target[0] }
    if (-not $target) { throw "Cannot resolve the link $($link.FullName)" }
    if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $link.FullName) $target }
    $path = $link.FullName
    [IO.Directory]::Delete($path) # removes the link only, never the target
    Copy-Item -LiteralPath $target -Destination $path -Recurse
  }
  $left = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($left.Count -gt 0) { throw "Links are left in the payload: $($left[0].FullName)" }
}

# ---- versions ------------------------------------------------------------------------------------------------------

$package = Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw "package.json has an invalid version: $version" }
$appName = [string]$package.name
$publisher = ([string]$package.author -replace '\s*[<(].*$', '').Trim()
if ($appName -eq '' -or $publisher -eq '') { throw 'package.json needs a name and an author' }

# The Node.js version is pinned in install.sh (NODE_VERSION="x.y.z"): the single place of the literal.
$nodeLine = Select-String -LiteralPath (Join-Path $repo 'packaging/install.sh') -Pattern '^NODE_VERSION="(\d+\.\d+\.\d+)"' | Select-Object -First 1
if ($null -eq $nodeLine) { throw 'Could not read NODE_VERSION from install.sh' }
$nodeVersion = $nodeLine.Matches[0].Groups[1].Value

$installerName = "message-summarize-$version-win-x64-setup"

if ($WorkDir -eq '') { $WorkDir = Join-Path ([IO.Path]::GetTempPath()) ('msum-installer-' + [guid]::NewGuid().ToString('N')) }
$work = $WorkDir
$stageDir = Join-Path $work 'stage'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$certFile = $null

try {
  if ($Stage) {
    # Third-party code runs in this phase (npm and the scripts of the dev dependencies): no signing secrets here.
    Remove-Item Env:WINDOWS_SIGN_PFX_BASE64, Env:WINDOWS_SIGN_PFX_PASSWORD, Env:WINDOWS_SIGN_TIMESTAMP_URL -ErrorAction SilentlyContinue
    Write-Host "Staging $installerName with Node.js $nodeVersion"
    if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }

    # ---- the package ----------------------------------------------------------------------------------------------------
    Push-Location $repo
    try {
      Invoke-Native npm @('run', 'build')
      Invoke-Native npm @('run', 'check:dist')
    } finally {
      Pop-Location
    }

    # ---- Node.js: download, verify, then extract ---------------------------------------------------------------------
    $nodeBase = "https://nodejs.org/dist/v$nodeVersion"
    $nodeName = "node-v$nodeVersion-win-x64"
    $sumsFile = Join-Path $work 'SHASUMS256.txt'
    $zipFile = Join-Path $work "$nodeName.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeBase/SHASUMS256.txt" -OutFile $sumsFile
    $expected = $null
    foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -eq "$nodeName.zip") { $expected = $Matches[1].ToLowerInvariant(); break }
    }
    if ($null -eq $expected) { throw "No official checksum for $nodeName.zip in SHASUMS256.txt" }
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeBase/$nodeName.zip" -OutFile $zipFile
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipFile).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 of $nodeName.zip does not match nodejs.org (expected $expected, got $actual). Nothing was extracted." }
    Write-Host "SHA-256 of $nodeName.zip verified"
    $extract = Join-Path $work 'node-extract'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    Expand-Archive -LiteralPath $zipFile -DestinationPath $extract
    $nodeExe = Join-Path $extract "$nodeName\node.exe"
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw "node.exe not found in $nodeName.zip" }

    # ---- the payload -------------------------------------------------------------------------------------------------------
    $app = Join-Path $stageDir 'app'
    New-Item -ItemType Directory -Path (Join-Path $stageDir 'node'), (Join-Path $stageDir 'bin'), $app | Out-Null
    # Only node.exe and its license: the program never needs npm at run time.
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stageDir 'node\node.exe')
    Copy-Item -LiteralPath (Join-Path $extract "$nodeName\LICENSE") -Destination (Join-Path $stageDir 'node\LICENSE')
    Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $stageDir 'LICENSE')
    New-Item -ItemType File -Path (Join-Path $stageDir '.message-summarize-prefix') | Out-Null

    # The app: package.json, the lockfile, the vendored sharp stub and the built dist/, then `npm ci` there, so the
    # exact versions of package-lock.json are installed (production only, no scripts). --install-links asks npm for
    # copies instead of links; whatever link is left is turned into a copy below.
    Copy-Item -LiteralPath (Join-Path $repo 'package.json'), (Join-Path $repo 'package-lock.json') -Destination $app
    Copy-Item -LiteralPath (Join-Path $repo 'vendor') -Destination (Join-Path $app 'vendor') -Recurse
    Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination (Join-Path $app 'dist') -Recurse
    $env:npm_config_update_notifier = 'false'
    Push-Location $app
    try {
      Invoke-Native npm @('ci', '--omit=dev', '--ignore-scripts', '--install-links', '--no-fund', '--no-audit', '--loglevel=error')
    } finally {
      Pop-Location
    }
    Convert-LinksToCopies $app
    $cli = Join-Path $app 'dist\main\cli.js'
    if (-not (Test-Path -LiteralPath $cli)) { throw "The staged app has no $cli" }

    # The production license check (non-strict: the named exception of libsignal is reported, not hidden) on the staged
    # tree, which is what the installer ships. Run from a file: Windows PowerShell 5.1 mangles quotes in arguments.
    $licenseScript = Join-Path $work 'check-staged-licenses.mjs'
    Write-TextFile $licenseScript (@(
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "import { pathToFileURL } from 'node:url'",
        'const repo = process.env.MSUM_REPO',
        "const { check } = await import(pathToFileURL(join(repo, 'scripts', 'check-licenses.mjs')).href)",
        "const exceptions = JSON.parse(readFileSync(join(repo, 'scripts', 'license-exceptions.json'), 'utf8'))",
        'const result = check({ dir: process.env.MSUM_STAGED_APP, exceptions })',
        'for (const line of result.out) console.log(line)',
        'for (const line of result.err) console.error(line)',
        'process.exit(result.code)'
      ) -join "`n")
    $env:MSUM_REPO = $repo
    $env:MSUM_STAGED_APP = $app
    Invoke-Native node @($licenseScript)

    # The shims find node and the program relative to their own folder (%~dp0, always quoted: paths with spaces work).
    $shim = @(
      '@echo off',
      'rem message-summarize shim (managed by the installer)',
      '"%~dp0..\node\node.exe" "%~dp0..\app\dist\main\cli.js" %*'
    ) -join "`r`n"
    Write-TextFile (Join-Path $stageDir 'bin\msum.cmd') ($shim + "`r`n")
    Write-TextFile (Join-Path $stageDir 'bin\message-summarize.cmd') ($shim + "`r`n")
    Write-Host "Staged the payload in $stageDir"
  }

  if ($Compile) {
    if (-not (Test-Path -LiteralPath (Join-Path $stageDir 'bin\msum.cmd'))) { throw "Nothing is staged in ${stageDir}: run with -Stage first" }
    Write-Host "Compiling $installerName"

    # ISCC.exe from the fixed Program Files folders only, never from PATH (nothing earlier in the job may redirect it).
    $iscc = $null
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
      if ($base -and (Test-Path -LiteralPath (Join-Path $base 'Inno Setup 6\ISCC.exe'))) { $iscc = Join-Path $base 'Inno Setup 6\ISCC.exe'; break }
    }
    if ($null -eq $iscc) { throw 'ISCC.exe was not found under Program Files (Inno Setup 6). Install it (choco install innosetup) and run again.' }

    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $OutDir = (Resolve-Path -LiteralPath $OutDir).Path
    # Only the files this script writes are replaced: the folder may hold other things.
    foreach ($name in "$installerName.exe", 'SHA256SUMS.txt') {
      $old = Join-Path $OutDir $name
      if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
    }

    $isccArgs = @(
      "/DAppName=$appName", "/DAppVersion=$version", "/DAppPublisher=$publisher",
      "/DStageDir=$stageDir", "/DOutputDir=$OutDir", "/DOutputName=$installerName", '/Q'
    )

    # Optional signing: only when both secrets are present. The password is passed to signtool, never printed.
    if ($env:WINDOWS_SIGN_PFX_BASE64 -and $env:WINDOWS_SIGN_PFX_PASSWORD) {
      $signtool = Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\*\x64\signtool.exe') -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($null -eq $signtool) { throw 'Signing was requested but signtool.exe was not found' }
      $certFile = Join-Path $work 'sign.pfx'
      [IO.File]::WriteAllBytes($certFile, [Convert]::FromBase64String($env:WINDOWS_SIGN_PFX_BASE64))
      $timestamp = if ($env:WINDOWS_SIGN_TIMESTAMP_URL) { $env:WINDOWS_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
      # A tiny wrapper keeps quotes and the password out of the iscc command line (Windows PowerShell 5.1 mangles quotes
      # in native arguments): it reads the certificate path and the password from the environment of the iscc process.
      $signCmd = Join-Path $work 'sign.cmd'
      if ($signCmd -match '\s') { throw "The work folder path has spaces ($work): cannot pass the sign tool to iscc" }
      $signLine = '"' + $signtool.FullName + '" sign /fd sha256 /td sha256 /tr ' + $timestamp + ' /f "%MSUM_SIGN_PFX%" /p "%WINDOWS_SIGN_PFX_PASSWORD%" %1'
      Write-TextFile $signCmd ("@echo off`r`n" + $signLine + "`r`n")
      $env:MSUM_SIGN_PFX = $certFile
      $isccArgs += '/DSign=1'
      $isccArgs += "/Smsumsign=$signCmd `$f"
      Write-Host 'Signing is on (certificate from the environment)'
    } else {
      Write-Host 'Signing is off (no WINDOWS_SIGN_PFX_BASE64 / WINDOWS_SIGN_PFX_PASSWORD): the installer is unsigned'
    }

    Invoke-Native $iscc ($isccArgs + (Join-Path $repo 'packaging\windows\message-summarize.iss'))

    $setup = Join-Path $OutDir "$installerName.exe"
    if (-not (Test-Path -LiteralPath $setup)) { throw "iscc did not produce $setup" }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant()
    Write-TextFile (Join-Path $OutDir 'SHA256SUMS.txt') ("$hash  $installerName.exe`n")
    if ($isccArgs -contains '/DSign=1') {
      $signature = Get-AuthenticodeSignature -LiteralPath $setup
      if ($signature.Status -eq 'NotSigned') { throw 'Signing was on but the installer is not signed' }
      Write-Host "Signature status: $($signature.Status)"
    }
    Write-Host "Built $setup"
    Write-Host "SHA-256 $hash"
  }
} finally {
  if ($certFile -and (Test-Path -LiteralPath $certFile)) { Remove-Item -LiteralPath $certFile -Force -ErrorAction SilentlyContinue }
  if (-not $keepWork) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
