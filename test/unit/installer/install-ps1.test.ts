import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { allowSubprocess } from '../../support/network-guard.js'

// install.ps1 is for Windows 11, and this suite also runs on machines that cannot run it. The static tests read the
// script and check the rules that protect users; they run everywhere. The runtime tests need PowerShell (`pwsh`) and
// run only the paths that touch nothing (-DryRun and the guards of the install folder) with a temporary profile. What
// needs a real Windows machine (download, unzip, the Run key, the PATH in the registry, the .cmd shims) is checked by
// hand, see the list in the report of the commit.
const root = join(import.meta.dirname, '..', '..', '..')
const script = join(root, 'packaging', 'install.ps1')
// .gitattributes checks install.ps1 out with CRLF, so the line-based checks below work on LF text.
const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
const shText = readFileSync(join(root, 'packaging', 'install.sh'), 'utf8')

/** The script without comments (line comments and the comment-based help block): what is left is what runs. */
const code = text
  .replace(/<#[\s\S]*?#>/g, '')
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, ''))
  .join('\n')

const lines = text.trimEnd().split('\n')

function keysOf(functionName: string): string[] {
  const start = text.indexOf(`function ${functionName} {`)
  expect(start).toBeGreaterThan(-1)
  const next = text.indexOf('\n  function ', start + 10)
  const body = text.slice(start, next === -1 ? undefined : next)
  return [...body.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*)\s*=\s*'/gm)].map((match) => match[1] ?? '').sort()
}

function messageOf(functionName: string, key: string): string {
  const start = text.indexOf(`function ${functionName} {`)
  const match = new RegExp(`^\\s{6}${key}\\s*=\\s*'(.*)'\\s*$`, 'm').exec(text.slice(start))
  return match?.[1] ?? ''
}

describe('install.ps1 (static)', () => {
  it('is pure ASCII, so it reads the same through irm, Windows PowerShell 5.1 and a file without a BOM', () => {
    expect([...text].every((char) => char.charCodeAt(0) < 128)).toBe(true)
  })

  it('never assigns to a variable PowerShell owns ($IsWindows is read-only in PowerShell 7, and names match case-insensitively)', () => {
    const owned =
      /^\s*\$(IsWindows|IsLinux|IsMacOS|IsCoreCLR|Host|Home|PID|Args|Input|Matches|PWD|Profile|Error|ShellId)\s*=/im
    expect(code.split('\n').filter((line) => owned.test(line))).toEqual([])
  })

  it('runs nothing until the whole script has arrived: the last statement calls the one function', () => {
    expect(lines.at(-1)).toBe('Invoke-MsumInstaller @PSBoundParameters')
    // before it there are only the help block, the param block and the definition of the function
    const beforeCall = code.slice(0, code.lastIndexOf('Invoke-MsumInstaller @PSBoundParameters'))
    const topLevel = beforeCall.replace(/^param\([\s\S]*?^\)\n/m, '')
    const outsideFunction = topLevel.replace(/^function Invoke-MsumInstaller \{[\s\S]*^\}\n/m, '')
    expect(outsideFunction.trim()).toBe('')
  })

  it('has the same options as install.sh, each with its environment variable', () => {
    for (const option of [
      'Version',
      'Tarball',
      'Prefix',
      'NoService',
      'NoOpen',
      'ModifyPath',
      'Uninstall',
      'DryRun',
      'Yes',
    ]) {
      expect(code).toMatch(new RegExp(`\\[(string|switch)\\]\\$${option}\\b`))
    }
    for (const name of [
      'MSUM_VERSION',
      'MSUM_TARBALL',
      'MSUM_PREFIX',
      'MSUM_NO_SERVICE',
      'MSUM_NO_OPEN',
      'MSUM_MODIFY_PATH',
      'MSUM_UNINSTALL',
    ]) {
      expect(code).toContain(`'${name}'`)
    }
  })

  it('has the safety basics: strict mode, stop on errors, cleanup in a finally, no execution of downloaded text', () => {
    expect(code).toMatch(/^\s*Set-StrictMode -Version 2\.0$/m)
    expect(code).toMatch(/^\s*\$ErrorActionPreference = 'Stop'$/m)
    expect(code).toMatch(/\} finally \{/)
    expect(code).toMatch(/Remove-Tree \$S\.Tmp/)
    expect(code).not.toMatch(/Invoke-Expression/i)
    expect(code).not.toMatch(/(^|[\s|;(&])iex\b/i)
    expect(code).not.toMatch(/\[scriptblock\]::Create/i)
    expect(code).not.toMatch(/Set-ExecutionPolicy/i)
    // the one use is the launcher of the daemon, for that process only, as the Run key does
    expect(code.match(/-ExecutionPolicy/gi)?.length).toBe(1)
    expect(code).toContain('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File')
    expect(code).not.toMatch(/DownloadString|Invoke-Command|Start-BitsTransfer/i)
  })

  it('needs no administrator rights and touches nothing outside the profile and HKCU', () => {
    expect(code).not.toMatch(/HKLM|LocalMachine|RunAs|-Verb\b|#Requires -RunAsAdministrator/i)
    expect(code).not.toMatch(
      /Register-ScheduledTask|schtasks|New-Service|sc\.exe|Add-MpPreference|Unblock-File|Set-MpPreference/i,
    )
    expect(code).not.toMatch(/WindowsApps/i)
    expect(code).toContain('CurrentUser.OpenSubKey')
    expect(code).not.toMatch(/Registry\]::(LocalMachine|ClassesRoot|Users)/)
  })

  it('talks only to nodejs.org, raw.githubusercontent.com and github.com, over https', () => {
    const hosts = [...text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*)/gi)].map((match) => match[1])
    expect(new Set(hosts)).toEqual(new Set(['nodejs.org', 'raw.githubusercontent.com', 'github.com']))
    expect(text).not.toMatch(/http:\/\/(?!\*)/)
    expect(code).toMatch(/StartsWith\('https:\/\/'/)
    expect(code).toContain('Tls12')
  })

  it('pins the same Node.js as install.sh, one that satisfies the engines of the package', () => {
    const pinned = /\$NodeVersion = '([^']+)'/.exec(code)?.[1]
    const shPinned = /^NODE_VERSION="([^"]+)"/m.exec(shText)?.[1]
    expect(pinned).toBeDefined()
    expect(pinned).toBe(shPinned)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines: { node: string } }
    expect(pkg.engines.node).toBe('>=22.16')
    const [major, minor] = (pinned ?? '').split('.').map(Number)
    expect(major === 22 && (minor ?? 0) >= 16).toBe(true)
    expect(code).toContain('$NodeMinMajor = 22')
    expect(code).toContain('$NodeMinMinor = 16')
  })

  it('verifies the SHA-256 against the list of the same host before it opens the archive, and guards zip-slip', () => {
    const verify = code.indexOf('Get-FileHash')
    const expand = code.indexOf('Expand-Archive')
    const slip = code.indexOf('ZipFile]::OpenRead')
    expect(verify).toBeGreaterThan(-1)
    expect(expand).toBeGreaterThan(verify)
    expect(slip).toBeGreaterThan(verify)
    expect(slip).toBeLessThan(expand)
    expect(code).toContain('SHASUMS256.txt')
    expect(code).toContain("Stop-Msum 5 'BadSum'")
    expect(code).toMatch(/Test-Inside \$resolved \$extract/)
  })

  it('installs with the safe npm flags, keeping the previous tree aside', () => {
    for (const flag of ['--ignore-scripts', '--no-fund', '--no-audit', '--no-save', '--prefix'])
      expect(code).toContain(`'${flag}'`)
    expect(code).toContain('node_modules.old')
    expect(code).toMatch(/if \(\$S\.ModulesAside\)/)
  })

  it('documents the exit codes of install.sh and uses each of them', () => {
    for (const exit of [
      '0 done',
      '1 failure',
      '2 wrong arguments',
      '3 unsupported system',
      '4 a tool is missing',
      '5 checksum mismatch',
      '6 installed, but the service could not be registered',
    ]) {
      expect(text).toContain(exit)
    }
    for (const exit of [1, 2, 3, 4, 5]) expect(code).toMatch(new RegExp(`Stop-Msum ${exit} `))
    expect(code).toContain('$S.ExitCode = 6')
    expect(code).toMatch(/if \(-not \[string\]::IsNullOrEmpty\(\$ScriptFile\)\) \{ exit \$result \}/)
    // under iex an `exit` would close the terminal of the person
    expect(code).toContain('$global:LASTEXITCODE = $result')
  })

  it('has the English and the Spanish messages under the same keys, and the same placeholders', () => {
    const en = keysOf('MessagesEn')
    const es = keysOf('MessagesEs')
    expect(en.length).toBeGreaterThan(40)
    expect(es).toEqual(en)
    for (const key of en) {
      const placeholders = (name: string) => [...new Set(messageOf(name, key).match(/\{\d\}/g) ?? [])].sort()
      expect(placeholders('MessagesEs'), key).toEqual(placeholders('MessagesEn'))
    }
    expect(code).toMatch(/\$lang -like 'es\*'/)
    expect(code).toContain('Get-UICulture')
  })

  it('refuses a dangerous install folder: data folder, broad folders, folders it did not create', () => {
    expect(code).toContain("$PrefixMarker = '.message-summarize-prefix'")
    for (const key of ['PrefixData', 'PrefixInData', 'PrefixUnsafe', 'PrefixNotOurs', 'PrefixChars'])
      expect(code).toContain(`'${key}'`)
    expect(code).toContain('MSUM_DATA_DIR')
    expect(code).toContain("'message-summarize'")
    expect(code).toContain('$env:APPDATA')
    expect(code).toContain('$env:USERPROFILE')
    expect(code).toContain('GetPathRoot')
    expect(code).toContain('ReparsePoint')
    // it compares physical paths, in both directions
    expect(code).toMatch(/Test-Inside \$pair\[1\] \$pair\[0\]/)
    expect(code).toMatch(/Test-Inside \$pair\[0\] \$pair\[1\]/)
  })

  it('marks its shims and never removes or overwrites one that is not its own', () => {
    expect(code).toContain("$ShimMark = 'REM message-summarize shim (managed by install.ps1)'")
    expect(code).toMatch(/if \(-not \(Test-ShimOurs \$Path\)\) \{ Stop-Msum 1 'ShimForeign'/)
    expect(code).toMatch(/if \(Test-ShimOurs \$candidate\) \{ Remove-Item/)
    expect(code).toContain("'message-summarize.cmd'")
    expect(code).toContain("'msum.cmd'")
    // the paths are quoted, and a path that cmd.exe would expand is refused
    expect(code).toContain('set `"NODE=$Node`"')
    expect(code).toContain('"%NODE%" ')
  })

  it('edits the PATH only on request, in HKCU, without freezing %VARIABLES%, and prints the exact command otherwise', () => {
    expect(code).toContain('DoNotExpandEnvironmentNames')
    expect(code).toMatch(/\} elseif \(\$ModifyPath\) \{|if \(\$ModifyPath\) \{/)
    expect(code).toContain("OpenSubKey('Environment'")
    expect(code).not.toContain('SetEnvironmentVariable')
    expect(code).toContain('MSUM_MODIFY_PATH')
  })

  it('does not install the service or open the web in a dry run, and surfaces the manual step when the CLI is gone', () => {
    expect(code).toContain('reg delete `"HKCU\\$RunKeyPath`" /v $RunValue /f')
    expect(code).toContain("$RunKeyPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'")
    expect(code).toContain("$RunValue = 'message-summarize'")
    expect(code).toContain("$LauncherName = 'daemon-launcher.ps1'")
    expect(code).toContain("'service', 'uninstall'")
    expect(code).toContain("@('service', 'install')")
  })
})

describe('install.ps1 (static): lessons of the review', () => {
  it('never assigns a read-only automatic variable ($isWindows, $IsWindows, $PID, $HOME, $Host)', () => {
    expect(code).not.toMatch(/\$(isWindows|IsLinux|IsMacOS)\b/i)
    expect(code).toContain('$onWindows')
    expect(code).not.toMatch(/\$(PID|HOME|Host|PSHOME|Error|Matches)\s*=/i)
  })

  it('stops the daemon and its launcher before it deletes or replaces anything', () => {
    expect(code).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(code).toContain('Stop-Process')
    const uninstall = code.slice(code.indexOf('function Invoke-Uninstall'), code.indexOf('function Invoke-Install'))
    const stop = uninstall.indexOf('Stop-Daemon')
    expect(stop).toBeGreaterThan(uninstall.indexOf("'service', 'uninstall'"))
    expect(stop).toBeLessThan(uninstall.indexOf('Move-Item -LiteralPath $Prefix'))
    expect(stop).toBeLessThan(uninstall.indexOf('Remove-UserPath'))
    const install = code.slice(code.indexOf('function Invoke-Install'))
    expect(install.indexOf('Stop-Daemon')).toBeGreaterThan(-1)
    expect(install.indexOf('Stop-Daemon')).toBeLessThan(install.indexOf('Install-Node'))
    expect(install.indexOf('Stop-Daemon')).toBeLessThan(install.indexOf("'node_modules.old'"))
  })

  it('uninstall moves the prefix aside first, so a locked file changes nothing, and reports without a stack trace', () => {
    const uninstall = code.slice(code.indexOf('function Invoke-Uninstall'), code.indexOf('function Invoke-Install'))
    expect(uninstall.indexOf('.removing-')).toBeLessThan(uninstall.indexOf('Remove-UserPath'))
    expect(uninstall).toContain("Stop-Msum 1 'UnLocked'")
    expect(uninstall).toContain("Warn 'UnLeft'")
  })

  it('starts the launcher hidden after the service step, never with -NoService on a fresh install', () => {
    expect(code).toContain('function Start-Daemon')
    expect(code).toContain('-WindowStyle Hidden -File')
    expect(code).toContain('if ($serviceUp -or ($daemonWasRunning -and -not $NoService))')
    expect(code).toContain('$maxTries = 30')
  })

  it('retries transient failures of the moves', () => {
    expect(code).toContain('function Invoke-Retry')
    expect(code).toMatch(/Invoke-Retry \{ Move-Item -LiteralPath \$modules -Destination \$aside \}/)
    expect(code).toContain("Stop-Msum 1 'InstallLocked'")
  })

  it('broadcasts the change of the environment after editing the PATH, and a failure does not abort', () => {
    expect(code).toContain('SendMessageTimeout')
    expect(code).toContain("'Environment'")
    expect(code).toMatch(/function Send-EnvironmentChange \{\s*try \{/)
    expect(code.match(/Send-EnvironmentChange/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('does not use --install-links (it breaks the file: stub of a tarball), and never deletes a tree recursively without removing the links first', () => {
    expect(code).not.toContain("'--install-links'")
    expect(code).toContain('function Remove-Links')
    expect(code).toContain('.Delete()')
    expect(code).toContain('rmdir /s /q')
    // the only Remove-Item -Recurse is the one inside Remove-Tree, after Remove-Links
    const recursive = [...code.matchAll(/Remove-Item[^\n]*-Recurse/g)]
    expect(recursive.length).toBe(1)
    const tree = code.slice(code.indexOf('function Remove-Tree'))
    expect(tree.indexOf('Remove-Links $Path')).toBeLessThan(tree.indexOf('-Recurse'))
  })

  it('checks the web with the output thrown away, no temporary file that could hold the token', () => {
    expect(code).toContain('open --print *> $null')
    expect(code).not.toContain('RedirectStandardOutput')
    expect(code).not.toContain('open.out')
  })

  it('writes shims with no absolute path for the private Node.js, and refuses unmappable paths for a system one', () => {
    expect(code).toContain('"%~dp0..\\node\\node.exe"')
    expect(code).toContain('"%~dp0..\\node_modules\\')
    expect(code).toContain('function Test-ShimSafe')
    expect(code).toContain('GetString($encoding.GetBytes($Path)) -ceq $Path')
    expect(code).toContain("if (Test-Inside $S.NodeBin $Prefix) { $shimNode = '' }")
    // an unusable system node is skipped (the private copy is downloaded), not written into a shim
    expect(code).toContain('if (Test-ShimSafe $candidate) { $nv = Get-NodeReport $candidate }')
  })

  it('prints a PATH command that keeps %VARIABLES% and doubles a single quote', () => {
    expect(code).toContain('DoNotExpandEnvironmentNames')
    expect(code).toContain(`$BinDir.Replace("'", "''")`)
    expect(code).toContain("'ExpandString'")
  })
})

// ---- runtime (only where PowerShell is installed) -------------------------------------------------------------------

function findPwsh(): string | null {
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['pwsh', 'pwsh.exe']) {
      const candidate = join(folder, name)
      if (folder !== '' && existsSync(candidate)) return candidate
    }
  }
  return null
}

const pwsh = findPwsh()
const runtime = pwsh === null ? describe.skip : describe

// The first pwsh start on a fresh Windows runner builds its module cache and can take longer than the global 30 s.
const PWSH_TIMEOUT_MS = 120_000
// A run of pwsh is cut a little before the one of the suite, so a slow start fails with what pwsh had printed and how
// long it took (spawnSync blocks the process: without its own limit the suite's timer only fires when pwsh returns).
const PWSH_RUN_TIMEOUT_MS = 100_000

runtime('install.ps1 (PowerShell, nothing is changed)', { timeout: PWSH_TIMEOUT_MS }, () => {
  let dir = ''
  let home = ''
  let revoke: () => void = () => undefined

  beforeAll(() => {
    revoke = allowSubprocess(pwsh ?? 'pwsh')
  })
  afterAll(() => revoke())
  beforeEach(() => {
    // On Windows tmpdir() can be an 8.3 short path (RUNNER~1) and the script prints the long one: use the long one
    dir = mkdtempSync(
      join(process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir(), 'msum-install-ps1-'),
    )
    home = join(dir, 'profile')
    mkdirSync(home)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // The environment given to pwsh replaces the whole one. On Windows PowerShell needs SystemRoot and windir, and
  // System32 on the PATH, to start at all; on Linux and macOS the system tools live in /usr/bin and /bin.
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const systemEnv: Record<string, string> =
    process.platform === 'win32'
      ? {
          SystemRoot: systemRoot,
          windir: systemRoot,
          ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
          // install.ps1 reads the architecture from these two (always set on a real Windows)
          ...Object.fromEntries(
            ['PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432'].flatMap((name) => {
              const value = process.env[name]
              return value === undefined ? [] : [[name, value]]
            }),
          ),
        }
      : {}
  const systemPath = process.platform === 'win32' ? [join(systemRoot, 'System32'), systemRoot] : ['/usr/bin', '/bin']

  function run(args: string[], env: Record<string, string> = {}) {
    const started = Date.now()
    const result = spawnSync(pwsh ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
      encoding: 'utf8',
      timeout: PWSH_RUN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      cwd: dir,
      env: {
        ...systemEnv,
        PATH: [dirname(process.execPath), dirname(pwsh ?? ''), ...systemPath].join(delimiter),
        HOME: home,
        // On Linux and macOS pwsh keeps its own cache and modules under XDG_* (default: inside HOME); they must not
        // end up in the temporary profile, whose content the tests compare.
        XDG_CACHE_HOME: join(dir, 'xdg', 'cache'),
        XDG_DATA_HOME: join(dir, 'xdg', 'data'),
        XDG_CONFIG_HOME: join(dir, 'xdg', 'config'),
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        APPDATA: join(home, 'AppData', 'Roaming'),
        TEMP: join(dir, 'temp'),
        TMP: join(dir, 'temp'),
        MSUM_DATA_DIR: join(home, 'data'),
        MSUM_LANG: 'en',
        ...env,
      },
    })
    return Object.assign(result, { elapsedMs: Date.now() - started })
  }
  const out = (result: { stdout: string; stderr: string; error?: Error; elapsedMs?: number }): string =>
    `${result.stdout}${result.stderr}` +
    (result.error === undefined
      ? ''
      : `\n[pwsh did not finish: ${result.error.message}, after ${result.elapsedMs ?? '?'} ms]`)
  // On Windows pwsh itself writes its module-analysis and startup caches under %LOCALAPPDATA% (the temporary profile),
  // whatever the script does; those two folders are not the script's doing and are left out of "nothing changed".
  const pwshOwn = /^AppData(\\Local(\\Microsoft(\\(PowerShell|Windows)(\\.*)?)?)?)?$/
  const tree = (path: string): string[] =>
    readdirSync(path, { recursive: true })
      .map(String)
      .filter((entry) => !(process.platform === 'win32' && pwshOwn.test(entry)))
      .sort()

  it('parses (the real parser of PowerShell)', () => {
    const result = spawnSync(
      pwsh ?? 'pwsh',
      [
        '-NoProfile',
        '-Command',
        `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }`,
      ],
      { encoding: 'utf8' },
    )
    expect(result.status, out(result)).toBe(0)
  })

  it('-DryRun changes nothing and lists the steps', () => {
    const result = run(['-DryRun', '-Prefix', join(home, 'app')])
    expect(result.status, out(result)).toBe(0)
    expect(out(result)).toContain('Dry run')
    expect(out(result)).toContain('msum service install')
    expect(out(result)).toContain("OpenSubKey('Environment'")
    expect(tree(home)).toEqual([])
  })

  it('takes its options from the environment when it cannot take parameters (irm | iex)', () => {
    const result = run([], {
      MSUM_DRY_RUN: '1',
      MSUM_NO_SERVICE: '1',
      MSUM_NO_OPEN: '1',
      MSUM_PREFIX: join(home, 'app'),
    })
    expect(result.status, out(result)).toBe(0)
    expect(out(result)).toContain('Dry run')
    expect(out(result)).not.toContain('msum service install')
    expect(out(result)).not.toContain('msum open')
    expect(tree(home)).toEqual([])
  })

  it('prints in Spanish when the language is Spanish', () => {
    const result = run(['-DryRun', '-Prefix', join(home, 'app')], { MSUM_LANG: 'es' })
    expect(out(result)).toContain('Simulacro')
  })

  it('rejects an invalid version and an unusable tarball', () => {
    expect(run(['-DryRun', '-Version', '--evil']).status).toBe(2)
    expect(run(['-DryRun', '-Version', '1.0.0;calc']).status).toBe(2)
    const bad = run(['-DryRun', '-Tarball', join(dir, 'missing.tgz')])
    expect(bad.status).toBe(1)
    expect(out(bad)).toContain('Cannot use -Tarball')
    expect(run(['-DryRun', '-Tarball', 'http://example.com/x.tgz']).status).toBe(1)
  })

  it('refuses an install folder that holds the data folder, is inside it, or is somebody else’s', () => {
    const holds = run(['-Yes', '-DryRun', '-Prefix', join(home, 'x')], { MSUM_DATA_DIR: join(home, 'x', 'data') })
    expect(holds.status).toBe(1)
    expect(out(holds)).toContain('contains your data folder')
    const inside = run(['-Yes', '-DryRun', '-Prefix', join(home, 'data', 'app')])
    expect(inside.status).toBe(1)
    expect(out(inside)).toContain('inside your data folder')
    const inDefault = run(['-Yes', '-DryRun', '-Prefix', join(home, 'AppData', 'Roaming', 'message-summarize', 'a')], {
      MSUM_DATA_DIR: '   ',
    })
    expect(inDefault.status).toBe(1)
    expect(out(inDefault)).toContain('inside your data folder')
    expect(run(['-Yes', '-DryRun', '-Prefix', home]).status).toBe(1)
    expect(run(['-Yes', '-DryRun', '-Prefix', dirname(home)]).status).toBe(1)
    const other = join(dir, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'precious.txt'), 'x')
    const foreign = run(['-Yes', '-DryRun', '-Prefix', other])
    expect(foreign.status).toBe(1)
    expect(readFileSync(join(other, 'precious.txt'), 'utf8')).toBe('x')
  })

  it('-Uninstall -DryRun removes nothing and says where the data is', () => {
    const result = run(['-Uninstall', '-DryRun', '-Prefix', join(home, 'app')])
    expect(result.status, out(result)).toBe(0)
    expect(out(result)).toContain('Removed the program. Your data was NOT deleted')
    expect(out(result)).toContain(join(home, 'data'))
    expect(tree(home)).toEqual([])
  })

  it('-Uninstall with nothing installed does nothing', () => {
    const result = run(['-Uninstall', '-Yes', '-Prefix', join(home, 'app')])
    expect(result.status, out(result)).toBe(0)
    expect(out(result)).toContain('Nothing to remove')
  })
})
