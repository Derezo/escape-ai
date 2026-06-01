#Requires -Version 5.1
<#
.SYNOPSIS
  run-dev.ps1 - Windows developer launcher for local Escape AI development.

.DESCRIPTION
  PowerShell sibling of scripts/run-dev.sh. Boots the whole local stack with one
  command: builds shared/, starts the authoritative server (:3000) and the Vite
  client (:5173) together, and tears both (and their node/vite grandchildren)
  down cleanly on Ctrl-C. Conservative and idempotent:

    * Conditionally runs `npm install` - only when node_modules is missing or
      package-lock.json / package.json is newer than the install marker.
    * Frees any server/client already listening on those ports before start.
    * -Clean wipes local dev data (the SQLite store) for a fresh-state run.

  Before doing any of that it runs a dependency preflight and, on a fresh
  machine, reports EVERY missing requirement at once with a Windows-specific
  install hint instead of failing deep inside `npm` with a cryptic error.

.EXAMPLE
  .\scripts\run-dev.ps1
  Install-if-needed, then run server + client.

.EXAMPLE
  .\scripts\run-dev.ps1 -Clean
  Also wipe server\data (fresh accounts/stats).

.EXAMPLE
  $env:SERVER_PORT=3001; $env:CLIENT_PORT=5180; .\scripts\run-dev.ps1
  Override ports.

.NOTES
  If you get "running scripts is disabled on this system", launch with:
    powershell -ExecutionPolicy Bypass -File .\scripts\run-dev.ps1
  or set per-user once: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

  Ctrl-C is read as a keystroke (not a kill signal) so the script can shut the
  server + client down cleanly. Press it once and give it a moment; if the
  child logs are very noisy and the keystroke doesn't register, close the
  window and the port-free on next run will reap any leftovers.
#>

[CmdletBinding()]
param(
  [switch]$Clean,
  [switch]$ForceInstall,
  [switch]$ServerOnly,
  [switch]$ClientOnly,
  [switch]$Help
)

# Stop on unhandled errors the way `set -e` does; we catch where we want to
# tolerate failures (port frees, kills) explicitly.
$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help -Detailed $PSCommandPath
  exit 0
}

# --- paths ------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = (Resolve-Path (Join-Path $ScriptDir '..')).Path

# --- config (env-overridable) -----------------------------------------------
$ServerPort = if ($env:SERVER_PORT) { [int]$env:SERVER_PORT } else { 3000 }
$ClientPort = if ($env:CLIENT_PORT) { [int]$env:CLIENT_PORT } else { 5173 }
# Point the dev client at the local server unless the caller overrides it.
if (-not $env:VITE_SERVER_URL) { $env:VITE_SERVER_URL = "http://localhost:$ServerPort" }
$RequiredNodeMajor = if ($env:REQUIRED_NODE_MAJOR) { [int]$env:REQUIRED_NODE_MAJOR } else { 22 }

$RunServer = -not $ClientOnly
$RunClient = -not $ServerOnly

# --- logging ----------------------------------------------------------------
function Write-Step  { param([string]$Msg) Write-Host "==> $Msg"      -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "[warn] $Msg"   -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[error] $Msg"  -ForegroundColor Red }

# --- dependency preflight ---------------------------------------------------
# Verify the host has everything required BEFORE we install/build/launch, and
# report EVERY missing or insufficient requirement at once with a concrete,
# Windows-specific install hint.
function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Major version from `node -v` ("v22.22.2" -> 22); $null if node absent/unparseable.
function Get-NodeMajor {
  if (-not (Test-Command 'node')) { return $null }
  try { $v = (& node -v) 2>$null } catch { return $null }
  if ($v -match '^v?(\d+)\.') { return [int]$Matches[1] }
  return $null
}

function Get-NodeInstallHint {
  return ("install Node.js >= {0}: 'winget install OpenJS.NodeJS.LTS' " +
          "(or 'nvm install {0}; nvm use {0}' with nvm-windows, or https://nodejs.org)") -f $RequiredNodeMajor
}

function Invoke-Preflight {
  $missing = $false

  # node - required, with a minimum major version.
  if (-not (Test-Command 'node')) {
    Write-Err ("node not found. {0}." -f (Get-NodeInstallHint))
    $missing = $true
  } else {
    $major = Get-NodeMajor
    if ($null -eq $major) {
      Write-Warn ("could not parse node version from '{0}'; need >= {1}." -f (& node -v), $RequiredNodeMajor)
    } elseif ($major -lt $RequiredNodeMajor) {
      Write-Err ("node {0} is too old; need >= {1}. Upgrade: 'winget upgrade OpenJS.NodeJS.LTS' " +
                 "(or 'nvm install {1}; nvm use {1}')." -f (& node -v), $RequiredNodeMajor)
      $missing = $true
    }
  }

  # npm - required (ships with Node.js).
  if (-not (Test-Command 'npm')) {
    Write-Err ("npm not found. It ships with Node.js - {0}." -f (Get-NodeInstallHint))
    $missing = $true
  }

  if ($missing) {
    Write-Err 'Missing required tooling (see above). Install it and re-run .\scripts\run-dev.ps1'
    Write-Err 'Tip: after a winget/nvm install, open a NEW terminal so PATH refreshes.'
    return $false
  }

  Write-Step ("Preflight OK (node {0}, npm {1})" -f (& node -v), (& npm -v))
  return $true
}

# --- conditional install ----------------------------------------------------
# Reinstall only when node_modules is absent OR package-lock.json / package.json
# is newer than our stamp (a marker file we touch after a successful install).
function Install-Deps {
  param([string]$Dir)
  $stamp   = Join-Path $Dir 'node_modules\.run-dev-installed'
  $rel     = $Dir.Substring($Root.Length).TrimStart('\','/')
  $need    = $ForceInstall.IsPresent
  if (-not $need -and -not (Test-Path (Join-Path $Dir 'node_modules'))) { $need = $true }
  if (-not $need -and -not (Test-Path $stamp)) { $need = $true }
  if (-not $need) {
    $stampTime = (Get-Item $stamp).LastWriteTimeUtc
    foreach ($f in @('package-lock.json','package.json')) {
      $p = Join-Path $Dir $f
      if ((Test-Path $p) -and ((Get-Item $p).LastWriteTimeUtc -gt $stampTime)) { $need = $true; break }
    }
  }

  if ($need) {
    Write-Step "Installing deps in $rel\"
    Push-Location $Dir
    try {
      & npm.cmd install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed in $rel (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    New-Item -ItemType File -Path $stamp -Force | Out-Null
    (Get-Item $stamp).LastWriteTimeUtc = (Get-Date).ToUniversalTime()
  } else {
    Write-Step "Deps up to date in $rel\ (skipping install)"
  }
}

# --- free a TCP port --------------------------------------------------------
# Kills whatever is LISTENING on $Port (stale dev run, crashed node, another
# vite). Prefers Get-NetTCPConnection; falls back to parsing netstat. Never
# touches anything not bound to the port.
function Clear-Port {
  param([int]$Port, [string]$Label)
  $procIds = @()
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
      $procIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty OwningProcess -Unique
    } catch { $procIds = @() }
  } else {
    # netstat fallback. NOTE: Windows netstat has no lowercase `-p tcp` (that
    # prints usage and lists nothing); we take plain `netstat -ano` and let the
    # LISTENING anchor + the local-address column do the filtering. Lines look
    # like:  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234  (IPv6 uses
    # [::]:3000), so we anchor :$Port to the local-address column and grab the
    # trailing PID.
    $procIds = netstat -ano |
               Select-String -Pattern ('\s(?:[\d.]+|\[[0-9a-fA-F:]+\]):' + $Port + '\s.*\sLISTENING\s+(\d+)\s*$') |
               ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
               Sort-Object -Unique
  }

  $procIds = @($procIds | Where-Object { $_ -and $_ -ne 0 })
  if ($procIds.Count -gt 0) {
    Write-Step ("Freeing {0} port {1} (killing PID(s): {2})" -f $Label, $Port, ($procIds -join ', '))
    foreach ($processId in $procIds) {
      # /T also kills the child tree; /F forces. Tolerate already-dead PIDs.
      taskkill /PID $processId /T /F 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 500
  }
}

# --- clean dev data ---------------------------------------------------------
function Clear-DevData {
  $data = Join-Path $Root 'server\data'
  if (Test-Path $data) {
    Write-Step 'Cleaning dev data (server\data\* - SQLite store + WAL/SHM)'
    # -Include is IGNORED unless the wildcard is in -Path (or -Recurse is set);
    # append \* so the SQLite files actually match and get removed.
    Get-ChildItem -Path (Join-Path $data '*') -Include '*.db','*.db-wal','*.db-shm' -File -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } else {
    Write-Step 'No dev data dir to clean (fresh state already).'
  }
}

# --- child process tracking + teardown --------------------------------------
# We launch each service via `cmd /c` so a single command string can `cd` and run
# npm. We keep the Process object; on teardown we `taskkill /T` its PID, which
# kills cmd AND the npm/node/vite grandchildren it spawned (the real listeners).
$script:Children = @()

function Start-DevService {
  param([string]$WorkDir, [string]$CmdLine, [string]$Label)
  # cmd.exe /c "cd /d <dir> && <cmdline>" - /d allows changing drive too.
  $full = "cd /d `"$WorkDir`" && $CmdLine"
  $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $full) `
         -NoNewWindow -PassThru
  $script:Children += [PSCustomObject]@{ Proc = $p; Label = $Label }
  return $p
}

function Stop-Children {
  if ($script:Children.Count -gt 0) { Write-Step 'Shutting down (server/client)...' }
  foreach ($c in $script:Children) {
    # Kill the whole tree UNCONDITIONALLY (don't gate on HasExited): cmd.exe can
    # exit while node/vite grandchildren live on, and taskkill harmlessly
    # returns 128 for an already-gone PID (swallowed by 2>$null). /T walks the
    # descendant tree, /F forces.
    if ($c.Proc) {
      taskkill /PID $c.Proc.Id /T /F 2>$null | Out-Null
    }
  }
  # Belt-and-suspenders: free the ports in case a grandchild escaped the tree
  # (e.g. cmd.exe died first, breaking the /T parentage before we got here).
  if ($script:Children.Count -gt 0) {
    if ($RunServer) { Clear-Port -Port $ServerPort -Label 'server' 2>$null }
    if ($RunClient) { Clear-Port -Port $ClientPort -Label 'client' 2>$null }
  }
}

# ============================================================================
try {
  # Fail fast with a complete list of what's missing before we touch anything.
  if (-not (Invoke-Preflight)) { exit 1 }

  if ($Clean) { Clear-DevData }

  # shared/ is required by both: client imports its src, server loads its dist.
  Install-Deps (Join-Path $Root 'shared')
  Write-Step 'Building shared/'
  Push-Location (Join-Path $Root 'shared')
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "shared build failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }

  if ($RunServer) {
    Install-Deps (Join-Path $Root 'server')
    Clear-Port -Port $ServerPort -Label 'server'
  }
  if ($RunClient) {
    Install-Deps (Join-Path $Root 'client')
    Clear-Port -Port $ClientPort -Label 'client'
  }

  # --- launch ---------------------------------------------------------------
  if ($RunServer) {
    Write-Step "Starting server  -> http://localhost:$ServerPort  (npm run dev, --watch)"
    # Set PORT for this service only, inside its own cmd invocation. NO space
    # before `&&` - cmd's `set` would capture it INTO the value ("3000 ").
    Start-DevService -WorkDir (Join-Path $Root 'server') `
      -CmdLine "set PORT=$ServerPort&& npm run dev" -Label 'server' | Out-Null
  }
  if ($RunClient) {
    Write-Step "Starting client  -> http://localhost:$ClientPort  (VITE_SERVER_URL=$($env:VITE_SERVER_URL))"
    # --strictPort so Vite fails loudly instead of silently hopping ports.
    Start-DevService -WorkDir (Join-Path $Root 'client') `
      -CmdLine "npm run dev -- --port $ClientPort --strictPort" -Label 'client' | Out-Null
  }

  Write-Step "Up. Open http://localhost:$ClientPort in two tabs. Ctrl-C to stop both."

  # Wait until either child exits (then tear the other down) or the user hits
  # Ctrl-C. We canNOT rely on Ctrl-C unwinding through try/finally on Windows
  # PowerShell 5.1 - a console Ctrl-C issues a pipeline stop that often kills the
  # runspace WITHOUT running `finally`, orphaning the node/vite grandchildren.
  # So we take Ctrl-C off the signal path with TreatControlCAsInput and read it
  # as a keystroke; the loop then owns shutdown and the outer finally always runs.
  # Only the keystroke approach works if we actually own an interactive console.
  # If stdin is redirected (CI, piped), [Console]::KeyAvailable throws - fall back
  # to a plain poll and lean on the outer finally + port sweep for cleanup.
  $interactive = $false
  try { $interactive = -not [Console]::IsInputRedirected } catch { $interactive = $false }

  $prevTreatCtrlC = $false
  if ($interactive) { $prevTreatCtrlC = [Console]::TreatControlCAsInput }
  try {
    if ($interactive) { [Console]::TreatControlCAsInput = $true }
    while ($true) {
      Start-Sleep -Milliseconds 200
      # Drain the key buffer; Ctrl-C arrives as Control modifier + 'C'.
      while ($interactive -and [Console]::KeyAvailable) {
        $k = [Console]::ReadKey($true)
        if (($k.Modifiers -band [ConsoleModifiers]::Control) -and $k.Key -eq 'C') {
          Write-Warn 'Ctrl-C received - shutting down...'
          return   # falls through to the outer finally -> Stop-Children
        }
      }
      $dead = $script:Children | Where-Object { $_.Proc.HasExited }
      if ($dead) {
        foreach ($d in $dead) { Write-Warn ("{0} exited (code {1})" -f $d.Label, $d.Proc.ExitCode) }
        break
      }
    }
  }
  finally {
    if ($interactive) { [Console]::TreatControlCAsInput = $prevTreatCtrlC }
  }
}
finally {
  Stop-Children
}
