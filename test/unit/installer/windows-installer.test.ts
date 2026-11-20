import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Static checks only: this machine cannot compile or run a Windows installer. The Inno compile, the silent install and
// uninstall, the PATH change and the Run key are checked by the release workflow (smoke test) and by hand on Windows.
const root = join(import.meta.dirname, '..', '..', '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts))
const text = (...parts: string[]) => read(...parts).toString('utf8')

const iss = text('packaging', 'windows', 'message-summarize.iss')
const buildBytes = read('scripts', 'build-windows-installer.ps1')
// .gitattributes checks the .ps1 out with CRLF: the checks below work on LF text.
const build = buildBytes.toString('utf8').replace(/\r\n/g, '\n')
const workflow = text('.github', 'workflows', 'release.yml')
const installSh = text('packaging/install.sh')

/** The lines of one [Section] of the .iss (comments and blanks removed). */
function section(name: string): string[] {
  const start = iss.search(new RegExp(`^\\[${name}\\]\\s*$`, 'm'))
  expect(start, `section [${name}]`).toBeGreaterThanOrEqual(0)
  const rest = iss.slice(start).split(/\r?\n/).slice(1)
  const end = rest.findIndex((line) => /^\[\w+\]\s*$/.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith(';'))
}

/** The body of a Pascal function or procedure of the [Code] section. */
function pascal(name: string): string {
  const match = new RegExp(`^(?:function|procedure) ${name}\\b[\\s\\S]*?^end;`, 'm').exec(iss)
  expect(match, `routine ${name}`).not.toBeNull()
  return match?.[0] ?? ''
}

describe('message-summarize.iss', () => {
  it('is UTF-8 with a BOM (it has Spanish text with accents), so Inno Setup does not read it as ANSI', () => {
    const bytes = read('packaging', 'windows', 'message-summarize.iss')
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('installs per user with no administrator rights and never into Program Files', () => {
    const setup = section('Setup').join('\n')
    expect(setup).toMatch(/^PrivilegesRequired=lowest$/m)
    expect(setup).not.toMatch(/PrivilegesRequiredOverridesAllowed/)
    expect(setup).toMatch(/^DefaultDirName=\{localappdata\}\\Programs\\message-summarize$/m)
    expect(iss).not.toMatch(/\{(pf|pf32|pf64|autopf|autopf32|autopf64|commonpf|commonpf32|commonpf64)\}/)
    expect(iss).not.toMatch(/Program Files/)
    expect(iss).not.toMatch(/HKLM|HKEY_LOCAL_MACHINE/)
  })

  it('is x64 only', () => {
    const setup = section('Setup').join('\n')
    expect(setup).toMatch(/^ArchitecturesAllowed=x64compatible$/m)
    expect(setup).toMatch(/^ArchitecturesInstallIn64BitMode=x64compatible$/m)
  })

  it('has a fixed AppId and takes name, version and publisher from the build defines', () => {
    const setup = section('Setup').join('\n')
    expect(setup).toMatch(/^AppId=\{\{7D3C9B52-4E1A-4F6B-9A83-5C0E2B6D1F47\}$/m)
    expect(setup).toMatch(/^AppName=\{#AppName\}$/m)
    expect(setup).toMatch(/^AppVersion=\{#AppVersion\}$/m)
    expect(setup).toMatch(/^AppPublisher=\{#AppPublisher\}$/m)
    for (const define of ['AppName', 'AppVersion', 'AppPublisher', 'StageDir', 'OutputDir', 'OutputName']) {
      expect(iss).toMatch(new RegExp(`#ifndef ${define}\\s+#error`))
    }
    // No other literal GUID that could be mistaken for the id.
    expect(iss.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g)).toHaveLength(1)
  })

  it('offers English and Spanish, with every custom message in both', () => {
    const languages = section('Languages').join('\n')
    expect(languages).toMatch(/Name: "english"; MessagesFile: "compiler:Default\.isl"/)
    expect(languages).toMatch(/Name: "spanish"; MessagesFile: "compiler:Languages\\Spanish\.isl"/)
    const keys = (lang: string) =>
      section('CustomMessages')
        .filter((l) => l.startsWith(`${lang}.`))
        .map((l) => l.slice(lang.length + 1, l.indexOf('=')))
        .sort()
    expect(keys('english').length).toBeGreaterThan(5)
    expect(keys('spanish')).toEqual(keys('english'))
  })

  it('shows the license from the staged LICENSE', () => {
    expect(section('Setup')).toContain('LicenseFile={#StageDir}\\LICENSE')
    expect(section('Files').join('\n')).toContain('{#StageDir}\\LICENSE')
  })

  it('stages a private node.exe, the app and the two shims', () => {
    const files = section('Files').join('\n')
    expect(files).toContain('{#StageDir}\\node\\*')
    expect(files).toContain('{#StageDir}\\app\\*')
    expect(files).toContain('{#StageDir}\\bin\\*')
    expect(files).toContain('{#PrefixMarker}')
  })

  it('has the three tasks, all on by default', () => {
    const tasks = section('Tasks')
    expect(tasks.map((t) => /Name: "(\w+)"/.exec(t)?.[1])).toEqual(['addtopath', 'service', 'openweb'])
    for (const task of tasks) expect(task).not.toMatch(/unchecked/)
  })

  it('runs init hidden, then the service install only with the service task', () => {
    const run = section('Run')
    const init = run.findIndex((l) => l.includes('" init"'))
    const service = run.findIndex((l) => l.includes('" service install"'))
    expect(init).toBeGreaterThanOrEqual(0)
    expect(service).toBeGreaterThan(init)
    expect(run[init]).toMatch(/runhidden/)
    expect(run[init]).not.toMatch(/Tasks:/)
    expect(run[service]).toMatch(/Tasks: service/)
    expect(run[service]).toMatch(/runhidden/)
  })

  it('opens the web with msum open in its own console and never captures or logs its output', () => {
    const open = section('Run').find((l) => l.includes('" open"'))
    expect(open).toMatch(/Tasks: openweb/)
    expect(open).not.toMatch(/runhidden/)
    expect(open).toMatch(/skipifsilent/)
    // The only other calls of `open` ask whether the web is up and discard everything.
    expect(iss).toContain("RunCli('open --print', Code)")
    expect(iss).not.toMatch(/--print.*>|>\s*\S*\.(txt|log)/)
    expect(iss).not.toMatch(/web-token/)
    // The only file written from [Code] is the ASCII script that stops the daemons.
    expect(iss.match(/SaveStringToFile/g)).toHaveLength(1)
    expect(pascal('StopDaemons')).toContain('SaveStringToFile')
    expect(section('Setup')).toContain('SetupLogging=no')
  })

  it('changes only the PATH of the user, and removes the entry only if the installer added it', () => {
    const registry = [...iss.matchAll(/\b(HKCU|HKLM|HKCR|HKU)\b/g)].map((m) => m[1])
    expect(new Set(registry)).toEqual(new Set(['HKCU']))
    expect(iss).toMatch(/ChangesEnvironment=yes/)
    expect(pascal('AddToUserPath')).toMatch(
      /RemovePathEntry\(Old, Entry, Found\);[\s\S]*if Found then\s+Exit;[\s\S]*RegWriteStringValue\(HKCU, StateKey, 'PathAdded'/,
    )
    // Case-insensitive (Uppercase compares), and no case-sensitive StringChangeEx on the PATH.
    expect(pascal('RemovePathEntry')).toContain('Uppercase(')
    expect(iss).not.toMatch(/StringChangeEx|Lowercase\(/)
    expect(pascal('RemoveFromUserPath')).toMatch(/PathAdded[\s\S]*Marker <> '1'\) then\s+Exit;/)
    expect(pascal('CurStepChanged')).toContain("WizardIsTaskSelected('addtopath')")
  })

  it('unregisters the service FIRST when uninstalling and stops there when it fails', () => {
    const init = pascal('InitializeUninstall')
    expect(init).toContain("RunCli('service uninstall', ExitCode)")
    expect(init).toMatch(/UnSvcFail[\s\S]*Result := False;/)
    // Own confirmation first (unless silent), BEFORE the service is touched; then the daemons of the install are stopped.
    expect(init).toContain('UninstallSilent')
    expect(init.indexOf('MsgBox(')).toBeGreaterThan(0)
    expect(init.indexOf('MsgBox(')).toBeLessThan(init.indexOf("RunCli('service uninstall'"))
    expect(init).toMatch(/else\s+StopDaemons;/)
    // The data of the uninstall that cannot continue is untouched, and the manual step is in both languages.
    const messages = section('CustomMessages').filter((l) => /\.(UnSvcFail|UnNoCli|UpgradeServiceFail)=/.test(l))
    expect(messages).toHaveLength(6)
    for (const line of messages) {
      expect(line).toContain(
        'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v message-summarize /f',
      )
    }
    // The removal of the PATH entry (a later step) is not before the service removal: it is in another routine.
    expect(pascal('CurUninstallStepChanged')).toContain('RemoveFromUserPath')
  })

  it('never deletes the data directory, and says where it is when the uninstall ends', () => {
    for (const name of ['UninstallDelete', 'InstallDelete']) {
      const entries = section(name)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry).toMatch(/Name: "\{app\}\\(app|node|bin)"/)
        expect(entry).not.toMatch(/userappdata|localappdata|MSUM_DATA_DIR|Application Data|AppData/i)
      }
    }
    expect(pascal('CurUninstallStepChanged')).toMatch(/usDone[\s\S]*UnDataKept[\s\S]*DataDir\(''\)/)
    expect(
      section('CustomMessages')
        .filter((l) => l.includes('UnDataKept='))
        .every((l) => l.includes('%1')),
    ).toBe(true)
    // DeleteFile, DelTree and RemoveDir are never called from [Code].
    expect(iss).not.toMatch(/\b(DelTree|DeleteFile|RemoveDir)\s*\(/)
    // The data directory is the one src/main/paths.ts uses by default.
    expect(pascal('DataDir')).toContain("GetEnv('MSUM_DATA_DIR')")
    expect(pascal('DataDir')).toContain('{userappdata}\\message-summarize')
  })

  it('refuses an install folder that overlaps the data folder, is too broad or is not ours', () => {
    const prepare = pascal('PrepareToInstall')
    expect(prepare).toMatch(/PathInside\(Dir, Data\) or PathInside\(Data, Dir\)/)
    expect(prepare).toContain('PrefixTooBroad')
    expect(prepare).toContain("'{#PrefixMarker}'")
    expect(prepare).toContain('PrefixNotOurs')
    // An upgrade unregisters the old daemon before anything is replaced, and aborts if it cannot.
    expect(prepare).toMatch(/RunCli\('service uninstall', ExitCode\)[\s\S]*UpgradeServiceFail/)
    expect(prepare).toMatch(/ServiceWasRemoved := True;\s+StopDaemons;/)
  })

  it('stops only the node.exe processes that run from the install, and puts the service back if the install ends early', () => {
    const stop = pascal('StopDaemons')
    expect(stop).toContain('Win32_Process')
    expect(stop).toContain('ExecutablePath')
    expect(stop).toContain('StartsWith($prefix')
    expect(stop).toContain("ExpandConstant('{app}')")
    const end = pascal('DeinitializeSetup')
    expect(end).toContain("RunCli('service install', Code)")
    expect(end).toContain('InitFail')
    expect(end).toContain('config.json')
  })

  it('asks Restart Manager to close a running daemon before the files are replaced', () => {
    const setup = section('Setup')
    expect(setup).toContain('CloseApplications=yes')
    expect(setup).toContain('RestartApplications=no')
  })

  it('signs only when the build passes Sign, and holds no certificate', () => {
    expect(iss).toMatch(/#ifdef Sign\s+SignTool=msumsign\s+SignedUninstaller=yes\s+#endif/)
    expect(iss).not.toMatch(/\.pfx|BEGIN CERTIFICATE|PRIVATE KEY/)
  })

  it('does not talk to the network or run anything but the private node and PowerShell for the launcher', () => {
    expect(iss).not.toMatch(/https?:\/\//)
    const programs = section('Run').map((l) => /Filename: "([^"]+)"/.exec(l)?.[1])
    expect(new Set(programs)).toEqual(
      new Set(['{app}\\node\\node.exe', '{sys}\\WindowsPowerShell\\v1.0\\powershell.exe']),
    )
  })
})

describe('build-windows-installer.ps1', () => {
  it('is plain ASCII (Windows PowerShell 5.1 reads a script without a BOM as ANSI)', () => {
    expect([...buildBytes].every((b) => b < 0x80)).toBe(true)
  })

  it('reads the Node.js version from install.sh and repeats the literal nowhere', () => {
    const pinned = /^NODE_VERSION="(\d+\.\d+\.\d+)"/m.exec(installSh)?.[1]
    expect(pinned).toBeDefined()
    expect(build).toContain("'packaging/install.sh'")
    expect(build).toContain('NODE_VERSION=')
    expect(build).not.toContain(pinned ?? '?')
    expect(build).not.toMatch(/\bv?\d{2}\.\d+\.\d+\b/)
  })

  it('reads the version, name and publisher from package.json', () => {
    expect(build).toContain("'package.json'")
    expect(build).toContain('$package.version')
    expect(build).toContain('$package.name')
    expect(build).toContain('$package.author')
  })

  it('verifies the SHA-256 against nodejs.org SHASUMS256.txt before extracting, and fails on a mismatch', () => {
    const sums = build.indexOf('SHASUMS256.txt')
    const hash = build.indexOf('Get-FileHash -Algorithm SHA256 -LiteralPath $zipFile')
    const mismatch = build.indexOf('if ($actual -ne $expected) { throw')
    const extract = build.indexOf('Expand-Archive')
    expect(sums).toBeGreaterThan(0)
    expect(hash).toBeGreaterThan(sums)
    expect(mismatch).toBeGreaterThan(hash)
    expect(extract).toBeGreaterThan(mismatch)
    expect(build.match(/Expand-Archive/g)).toHaveLength(1)
    expect(build).toContain('https://nodejs.org/dist/')
    expect(build).not.toMatch(/Invoke-Expression|\biex\b/)
  })

  it('packs without scripts (after an explicit build) and installs the app without scripts or dev dependencies', () => {
    expect(build).toContain("'check:dist'")
    // The payload follows package-lock.json: npm ci in a copy of package.json, the lockfile, vendor/ and dist/.
    expect(build).toMatch(/'ci', '--omit=dev', '--ignore-scripts', '--install-links'/)
    expect(build).toContain("'package-lock.json'")
    expect(build).not.toMatch(/npm pack|'install'/)
    expect(build).toContain('Convert-LinksToCopies $app')
    // The production license check runs on the staged tree, not strict.
    expect(build).toContain('MSUM_STAGED_APP')
    expect(build).toContain('check-licenses.mjs')
    expect(build).not.toContain('--strict')
    expect(build).toContain('[switch]$Stage')
    expect(build).toContain('[switch]$Compile')
    // Only the files it writes are replaced in the output folder.
    expect(build).not.toMatch(/Get-ChildItem -LiteralPath \$OutDir[^\n]*Remove-Item/)
    expect(build).toContain('"$installerName.exe", \'SHA256SUMS.txt\'')
  })

  it('writes shims with the marker, relative to their folder and quoted', () => {
    expect(build).toContain('rem message-summarize shim (managed by the installer)')
    expect(build).toContain('"%~dp0..\\node\\node.exe" "%~dp0..\\app\\dist\\main\\cli.js" %*')
    expect(build).toContain("'bin\\msum.cmd'")
    expect(build).toContain("'bin\\message-summarize.cmd'")
  })

  it('runs iscc with the defines the .iss requires, and names the outputs', () => {
    for (const define of ['AppName', 'AppVersion', 'AppPublisher', 'StageDir', 'OutputDir', 'OutputName']) {
      expect(build).toContain(`/D${define}=`)
      expect(iss).toContain(`#ifndef ${define}`)
    }
    expect(build).toContain('message-summarize-$version-win-x64-setup')
    expect(build).toContain('SHA256SUMS.txt')
    expect(build).toContain('packaging\\windows\\message-summarize.iss')
  })

  it('fails on any step error and cleans up its temporary folder', () => {
    expect(build).toContain("$ErrorActionPreference = 'Stop'")
    expect(build).toContain('$LASTEXITCODE -ne 0')
    expect(build).toMatch(/finally \{[\s\S]*Remove-Item -LiteralPath \$work -Recurse -Force/)
  })

  it('signs only when the optional secrets are in the environment, and keeps no certificate', () => {
    // The compile phase finds ISCC.exe and signtool.exe in fixed Program Files folders, never through PATH.
    expect(build).not.toContain('Get-Command')
    expect(build).toContain("'Inno Setup 6\\ISCC.exe'")
    expect(build).toContain('Windows Kits\\10\\bin')
    expect(build).toContain('Get-AuthenticodeSignature')
    expect(build).toMatch(/if \(\$env:WINDOWS_SIGN_PFX_BASE64 -and \$env:WINDOWS_SIGN_PFX_PASSWORD\)/)
    // They are read only in the compile phase, and removed from the environment in the stage phase.
    expect(build.indexOf('if ($env:WINDOWS_SIGN_PFX_BASE64 -and')).toBeGreaterThan(build.indexOf('if ($Compile) {'))
    expect(build).toMatch(
      /if \(\$Stage\) \{[\s\S]*Remove-Item Env:WINDOWS_SIGN_PFX_BASE64, Env:WINDOWS_SIGN_PFX_PASSWORD/,
    )
    expect(build).toContain('/DSign=1')
    expect(build).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY/)
    expect(build).toMatch(/finally \{[\s\S]*\$certFile[\s\S]*Remove-Item -LiteralPath \$certFile/)
  })
})

/** The text of one job of the workflow (from `  name:` to the next job). */
function job(name: string): string {
  const match = new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(workflow)
  expect(match, `job ${name}`).not.toBeNull()
  // Comments are not code: the tests look at what the job runs.
  return (match?.[0] ?? '').replace(/^\s*#.*\n/gm, '')
}

describe('release.yml', () => {
  it('runs on v* tags and by hand, never on pull_request_target', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- (["'])v\*\1\n {2}workflow_dispatch:/m)
    expect(workflow).not.toMatch(/pull_request_target|pull_request:|workflow_run/)
  })

  it('is read-only by default and only the release job can write', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m)
    const writes = [...workflow.matchAll(/^\s*([\w-]+): write\s*$/gm)].map((m) => m[1])
    expect(writes).toEqual(['contents'])
    expect(job('release')).toMatch(/permissions:\n {6}contents: write/)
    for (const name of ['windows-stage', 'windows-sign', 'windows-smoke']) expect(job(name)).not.toMatch(/: write/)
    expect(job('source-tarball')).not.toMatch(/: write/)
  })

  it('pins every action by a full commit SHA with its version in a comment', () => {
    const uses = [...workflow.matchAll(/^\s*- uses: (\S+)(.*)$/gm)]
    expect(uses.length).toBeGreaterThanOrEqual(6)
    for (const [, action, rest] of uses) {
      expect(action, rest).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
      expect(rest).toMatch(/^ # v\d+\.\d+\.\d+$/)
    }
    expect([...workflow.matchAll(/\buses:/g)]).toHaveLength(uses.length)
  })

  it('creates the release only on a tag push, after the signed build, its smoke test and the tarball', () => {
    const release = job('release')
    expect(release).toMatch(/needs: \[windows-smoke, windows-sign, source-tarball\]/)
    expect(release).toContain("if: github.event_name == 'push' && github.ref_type == 'tag'")
    expect(release).toContain('gh release create')
    expect(release).toContain('--verify-tag')
    expect(workflow.match(/gh release create/g)).toHaveLength(1)
    for (const name of ['windows-stage', 'windows-sign', 'windows-smoke']) expect(job(name)).not.toContain('gh release')
  })

  it('stages in a job with no secrets and no environment, and hands the payload over as an archive with its hash', () => {
    const stage = job('windows-stage')
    expect(stage).toContain('runs-on: windows-latest')
    expect(stage).toContain('node-version: 22')
    expect(stage).toContain('npm ci')
    expect(stage).toContain('-Stage')
    expect(stage).not.toMatch(/secrets|SIGN|environment:|-Compile|iscc|choco/i)
    expect(stage).toMatch(/stage_sha256/)
    expect(stage).toContain('name: windows-stage')
  })

  it('signs in a fresh job that runs no npm and no PATH lookup, under the protected environment', () => {
    const sign = job('windows-sign')
    expect(sign).toContain('needs: windows-stage')
    expect(sign).toContain('runs-on: windows-latest')
    // The environment: release-signing on tag pushes, a secret-less one otherwise.
    expect(sign).toMatch(
      /environment: \$\{\{ \(github\.event_name == 'push' && github\.ref_type == 'tag'\) && 'release-signing' \|\| 'release-dryrun' \}\}/,
    )
    // No third-party code before the signing step: no npm, no node, no setup-node, no Get-Command, no bare tool names.
    expect(sign).not.toMatch(/\bnpm\b|\bnpx\b|setup-node|Get-Command|\bwhere\b|\bnode\b/)
    expect(sign).not.toMatch(/(^|\s)(choco|tar|iscc|signtool)(\.exe)?\s/m)
    // The hash of the payload is verified (manifest and the stage job's output) BEFORE it is unpacked.
    const verify = sign.indexOf('The payload does not match its manifest')
    const output = sign.indexOf('The payload does not match the hash of the stage job')
    const unpack = sign.indexOf('tar.exe" -x')
    expect(verify).toBeGreaterThan(0)
    expect(output).toBeGreaterThan(verify)
    expect(unpack).toBeGreaterThan(output)
    expect(sign).toContain('needs.windows-stage.outputs.stage_sha256')
    // Pinned Inno Setup, installed with the choco of its fixed location; ISCC by its absolute path.
    expect(sign).toMatch(/choco\.exe' install innosetup --version \d+\.\d+\.\d+ --allow-downgrade/)
    expect(sign).toContain(`Join-Path \${env:ProgramFiles(x86)} 'Inno Setup 6\\ISCC.exe'`)
    // The secrets reach only the compile step of this job.
    const compile = /- name: Compile and sign the installer[\s\S]*?(?=\n {6}- )/.exec(sign)?.[0] ?? ''
    expect(compile).toContain('-Compile')
    expect(compile).toContain('secrets.WINDOWS_SIGN_PFX_BASE64')
    expect(compile).toContain('secrets.WINDOWS_SIGN_PFX_PASSWORD')
    expect(sign.match(/secrets\./g)).toHaveLength(2)
    expect(sign).toContain('name: windows-installer')
  })

  it('has the secrets nowhere but in the signing job, and the header tells the owner how to protect them', () => {
    for (const name of ['windows-stage', 'windows-smoke', 'source-tarball', 'release']) {
      expect(job(name), name).not.toMatch(/secrets\.|WINDOWS_SIGN/)
    }
    expect(workflow).toMatch(/^# .*release-signing/m)
    expect(workflow).toMatch(/REQUIRED\n# REVIEWERS|REQUIRED REVIEWERS/)
  })

  it('smoke tests the final installer in a job without secrets or environment, both with no tasks and with the service', () => {
    const smoke = job('windows-smoke')
    expect(smoke).toContain('needs: windows-sign')
    expect(smoke).not.toMatch(/secrets|SIGN|environment:|npm ci/)
    expect(smoke).toContain('name: windows-installer')
    expect(smoke).toContain('/VERYSILENT')
    // Tasks are switched off with /MERGETASKS and "!", never with an empty /TASKS=.
    expect(smoke).toContain('/MERGETASKS="!addtopath,!service,!openweb"')
    expect(smoke).toContain('/MERGETASKS="service,addtopath,!openweb"')
    expect(workflow).not.toMatch(/\/TASKS=/)
    expect(smoke.match(/unins000\.exe/g)).toHaveLength(2)
    expect(smoke).toContain('Get-InstallNodes')
    expect(smoke).toContain('--version')
  })

  it('packs the npm tarball with checksums on ubuntu', () => {
    const source = job('source-tarball')
    expect(source).toContain('runs-on: ubuntu-latest')
    expect(source).toContain('npm pack')
    expect(source).toContain('sha256sum')
  })

  it('never publishes to npm and never pipes a download into a shell', () => {
    expect(workflow).not.toMatch(/npm publish|npm\s+dist-tag|NODE_AUTH_TOKEN|NPM_TOKEN|registry-url/)
    expect(workflow).not.toMatch(/\|\s*(sh|bash|pwsh|powershell|iex)\b/i)
    expect(workflow).not.toMatch(/Invoke-Expression|\biex\b|curl|Invoke-WebRequest|iwr /i)
  })

  it('uses no secrets but the optional signing ones (and the job token)', () => {
    const secrets = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))
    expect(secrets).toEqual(new Set(['WINDOWS_SIGN_PFX_BASE64', 'WINDOWS_SIGN_PFX_PASSWORD']))
    // The signing secrets reach only the compile step.
    expect(workflow.match(/WINDOWS_SIGN_PFX_BASE64: \$\{\{ secrets/g)).toHaveLength(1)
    expect(workflow).not.toMatch(/secrets\.GITHUB_TOKEN/)
    expect(workflow).not.toMatch(/persist-credentials: true/)
  })

  it('does not put event data into scripts (it goes through env)', () => {
    for (const run of workflow.matchAll(/run: \|?\n?([\s\S]*?)(?=\n\s+- |\n\s+\w+:|$)/g)) {
      expect(run[1]).not.toMatch(/\$\{\{\s*github\.(event|head_ref)/)
    }
  })
})
