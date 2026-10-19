# PIXEL HOLD'EM relay: one-command setup for a Windows laptop.
# Run in PowerShell (safe to repeat):
#   irm https://raw.githubusercontent.com/LVXCAS/pixel-poker/main/relay/setup-windows.ps1 | iex
# Installs Git, Node LTS, cloudflared and gh (winget), clones the repo to ~\pixel-poker,
# installs the relay, starts it, and starts it again at every logon.
# Opt out of the logon task: $env:PP_NO_AUTOSTART = "1" before running.
$ErrorActionPreference = "Stop"
$Repo = "LVXCAS/pixel-poker"
$Dir = Join-Path $HOME "pixel-poker"
$TaskName = "PixelPokerRelay"

function Say($msg) { Write-Host "-> $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user;$env:ProgramFiles\Git\bin;$env:ProgramFiles\nodejs;${env:ProgramFiles(x86)}\cloudflared;$env:ProgramFiles\cloudflared;$env:ProgramFiles\GitHub CLI"
}

function Ensure($cmd, $wingetId) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget is missing. Install 'App Installer' from the Microsoft Store, then run this again."
  }
  Say "installing $wingetId"
  winget install --id $wingetId -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh-Path
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "$cmd still not found after install. Close PowerShell, open a new one, run this again."
  }
}

Refresh-Path
Ensure git "Git.Git"
Ensure node "OpenJS.NodeJS.LTS"
Ensure cloudflared "Cloudflare.cloudflared"
Ensure gh "GitHub.cli"

$bash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
if (-not (Test-Path $bash)) { Fail "Git Bash not found at $bash" }

gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "GitHub is not logged in. Run:  gh auth login   then run this again." }
gh auth setup-git | Out-Null

if (Test-Path (Join-Path $Dir ".git")) {
  Say "updating $Dir"
  git -C $Dir pull --rebase --autostash -q
} else {
  Say "cloning $Repo to $Dir"
  # LF endings so bash can run the .sh scripts
  git -c core.autocrlf=false clone -q "https://github.com/$Repo.git" $Dir
}
git -C $Dir config core.autocrlf false

# start.sh commits relay.json, so the clone needs an identity
if (-not (git -C $Dir config user.email)) {
  $login = gh api user --jq .login
  $id = gh api user --jq .id
  git -C $Dir config user.name $login
  git -C $Dir config user.email "$id+$login@users.noreply.github.com"
}

Say "installing relay packages"
Push-Location (Join-Path $Dir "relay")
npm ci --omit=dev --no-audit --no-fund | Out-Null
Pop-Location

$launcher = Join-Path $Dir "relay\start-windows.cmd"
if ($env:PP_NO_AUTOSTART -ne "1") {
  Say "starting the relay at every logon (task: $TaskName)"
  $action = New-ScheduledTaskAction -Execute $launcher
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
}

Say "starting the relay now (a window opens; leave it open)"
Start-Process $launcher

Say "waiting for the public relay URL (up to 90s)"
$deadline = (Get-Date).AddSeconds(90)
$url = $null
while ((Get-Date) -lt $deadline -and -not $url) {
  Start-Sleep 3
  try { $url = (Get-Content (Join-Path $Dir "relay.json") -Raw | ConvertFrom-Json).url } catch { }
  if ($url -and $url -notmatch "trycloudflare") { $url = $null }
}
if (-not $url) {
  Fail "no relay URL yet. Look at the relay window. If it says 'tunnel start failed', this Wi-Fi blocks Cloudflare tunnels."
}
$healthUrl = ($url -replace "^wss://", "https://") + "/health"
$health = try { (Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 15).Content } catch { "not answering yet (new links take ~30s)" }
Write-Host ""
Write-Host "relay: $url" -ForegroundColor Green
Write-Host "health: $health"
Write-Host "stop it: close the relay window.  remove autostart: Unregister-ScheduledTask $TaskName"
