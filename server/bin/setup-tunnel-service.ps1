# One-time setup of the Cloudflare Tunnel as a Windows service.
# Run in an administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\xampp\htdocs\My-Assistant\server\bin\setup-tunnel-service.ps1 [-TunnelId <id>] [-Hostname <name>]
# The tunnel's id and public hostname are read from the existing tunnel config (C:\ProgramData\cloudflared\config.yml,
# or the one "cloudflared tunnel create" wrote in your user folder) unless given.
#
# 1. Restarts Apache, so the API-only site (conf\extra\httpd-my-assistant.conf) is loaded.
# 2. Checks that site answers only with the API: if phpMyAdmin (or anything else) is reachable through it, it stops
#    without starting the tunnel.
# 3. Puts the tunnel's config and credentials in C:\ProgramData\cloudflared (SYSTEM, Administrators and the owner only)
#    and runs the "Cloudflared" service with them. A locally configured tunnel needs "tunnel --config ... run" on the
#    service's command line; "cloudflared service install" alone starts it without arguments, and it exits at once.

param([string]$TunnelId = '', [string]$Hostname = '')

$ErrorActionPreference = 'Stop'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$userDir = "$env:USERPROFILE\.cloudflared"
$dir = 'C:\ProgramData\cloudflared'
foreach ($cfg in "$dir\config.yml", "$userDir\config.yml") {
    if (Test-Path $cfg) {
        $text = Get-Content $cfg -Raw
        if (-not $TunnelId -and $text -match '(?m)^tunnel:\s*(\S+)') { $TunnelId = $Matches[1] }
        if (-not $Hostname -and $text -match '(?m)hostname:\s*(\S+)') { $Hostname = $Matches[1] }
    }
}
if (-not $TunnelId -or -not $Hostname) { throw 'Give -TunnelId and -Hostname (no tunnel config found to read them from).' }
$tunnelId = $TunnelId

Write-Host '1/3 Restarting Apache...'
Restart-Service Apache2.4
Start-Sleep -Seconds 3

Write-Host '2/3 Checking the API-only site...'
function Get-Body([string]$url) {
    try { return (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 10).Content }
    catch { if ($_.ErrorDetails) { return $_.ErrorDetails.Message } else { return "unreachable: $($_.Exception.Message)" } }
}
$health = Get-Body 'http://127.0.0.1:8090/health'
if ($health -notmatch '"ok":true') { throw "The API site doesn't answer /health ($health). Tunnel not started." }
foreach ($path in '/phpmyadmin/', '/webalizer/', '/licenses/', '/dashboard/', '/cgi-bin/', '/manual/') {
    $body = Get-Body "http://127.0.0.1:8090$path"
    if ($body -notmatch '^\{"error"') { throw "$path is reachable through the API site. Tunnel not started." }
}
Write-Host '    OK: only the API answers.'

Write-Host '3/3 Setting up the tunnel service...'
New-Item -ItemType Directory -Force $dir | Out-Null
if (-not (Test-Path "$dir\$tunnelId.json")) { Copy-Item "$userDir\$tunnelId.json" $dir -Force }
if (-not (Test-Path "$dir\config.yml")) {
    @("tunnel: $tunnelId", "credentials-file: C:/ProgramData/cloudflared/$tunnelId.json", 'ingress:',
      "  - hostname: $Hostname", '    service: http://127.0.0.1:8090', '  - service: http_status:404') |
        Set-Content "$dir\config.yml" -Encoding ascii
}
if (-not (Get-Service Cloudflared -ErrorAction SilentlyContinue)) { & $cloudflared service install }
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared' ImagePath "`"$cloudflared`" tunnel --config $dir\config.yml run"
Restart-Service Cloudflared
Start-Sleep -Seconds 8
Get-Service Cloudflared | Select-Object Name, Status, StartType | Format-Table
Write-Host "Done. Check https://$Hostname/health in a browser."
