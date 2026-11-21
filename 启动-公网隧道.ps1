# 寰途｜公网访问（Tailscale Funnel）
#
# 为什么用它：你已经装了 Tailscale 并登录，Funnel 能给一个固定的 HTTPS 域名，
# 对方不用装任何东西、不用点跳转页，直接开浏览器就行。
#
# 前提：服务已经用公开模式跑起来了（access code + HUANTU_PUBLIC_HOST 里包含这个 ts.net 域名）。
# 用法：右键「使用 PowerShell 运行」，或 ./启动-公网隧道.ps1

$ErrorActionPreference = 'Stop'

$port = if ($env:HUANTU_PORT) { $env:HUANTU_PORT } else { 8788 }

$ts = @(
  'D:\Program Files\Tailscale\tailscale.exe',
  'C:\Program Files\Tailscale\tailscale.exe',
  "$env:LOCALAPPDATA\Programs\Tailscale\tailscale.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $ts) {
  Write-Host '  没找到 Tailscale。请先安装并登录，或用 cloudflared 方案（见 README）。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

$status = & $ts status 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host '  Tailscale 未登录或服务未运行，请先在托盘里登录。' -ForegroundColor Red
  Write-Host $status
  Read-Host '按回车退出'
  exit 1
}

$dns = (& $ts status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
if (-not $dns) {
  Write-Host '  拿不到 Tailscale 域名，请确认 tailnet 已开启 MagicDNS。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

Write-Host ''
Write-Host '  寰途 · 公网访问（Tailscale Funnel）' -ForegroundColor DarkGreen
Write-Host "  将暴露：https://$dns  →  本机 $port 端口" -ForegroundColor DarkGray
Write-Host ''

# 尝试开启；如果 tailnet 没启用 Funnel，会返回一个启用链接
$out = & $ts funnel --bg $port 2>&1
if ($out -match 'not enabled') {
  Write-Host '  你的 tailnet 还没启用 Funnel。请打开下面这个链接，点一下启用：' -ForegroundColor Yellow
  $link = ($out | Select-String -Pattern 'https://login\.tailscale\.com/\S+').Matches.Value
  if ($link) { Write-Host "    $link" -ForegroundColor White }
  Write-Host ''
  Read-Host '  启用后按回车，我再试一次'
  $out = & $ts funnel --bg $port 2>&1
}

if ($LASTEXITCODE -ne 0) {
  Write-Host '  开启失败：' -ForegroundColor Red
  Write-Host $out
  Read-Host '按回车退出'
  exit 1
}

Write-Host '  已开启。对方访问地址：' -ForegroundColor Green
Write-Host "    https://$dns" -ForegroundColor White
Write-Host ''
Write-Host '  两条注意事项：' -ForegroundColor Yellow
Write-Host "  1) 服务的 HUANTU_PUBLIC_HOST 里必须包含 $dns，否则会 403。" -ForegroundColor DarkGray
Write-Host '     例：$env:HUANTU_PUBLIC_HOST="<LAN_IP>, '"$dns"'"' -ForegroundColor DarkGray
Write-Host '  2) 关掉公开访问：tailscale funnel reset' -ForegroundColor DarkGray
Write-Host ''
