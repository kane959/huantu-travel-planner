# 寰途｜公网试用模式启动
#
# 两种用法：
#   A. 本机隧道（推荐，家宽/公司网也能用）：保持 127.0.0.1，另开一个窗口跑隧道，
#      npx localtunnel --port 8788     或     cloudflared tunnel --url http://127.0.0.1:8788
#      然后把隧道给出的域名填进 HUANTU_PUBLIC_HOST。
#   B. 云服务器：把 HUANTU_BIND_HOST 设为 0.0.0.0，并且必须放在 HTTPS 反向代理后面。
#
# 用法：右键「使用 PowerShell 运行」，或 ./启动-公网试用.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = if ($env:HUANTU_PORT) { $env:HUANTU_PORT } else { 8788 }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  未找到 Node.js。请先安装 Node.js 22 或更高版本。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}
$version = (& node -v) -replace '^v', ''
if ([int]($version.Split('.')[0]) -lt 22) {
  Write-Host "  当前 Node.js 版本为 $version，需要 22 或更高版本。" -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

# ---- 访问码：没有就现场生成一个，绝不写进任何文件 ----
if (-not $env:HUANTU_ACCESS_CODE -or $env:HUANTU_ACCESS_CODE.Length -lt 12) {
  $bytes = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $env:HUANTU_ACCESS_CODE = [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').TrimEnd('=')
  Write-Host ''
  Write-Host '  已生成本次访问码（只显示这一次，请复制后发给对方）：' -ForegroundColor Yellow
  Write-Host "    $($env:HUANTU_ACCESS_CODE)" -ForegroundColor White
  Write-Host '  想固定访问码，就设置环境变量 HUANTU_ACCESS_CODE 后重新启动。' -ForegroundColor DarkGray
}

# ---- 公开域名 ----
$publicHost = $env:HUANTU_PUBLIC_HOST
if (-not $publicHost) {
  Write-Host ''
  Write-Host '  请输入访客将使用的域名（隧道域名或你的域名，例如 abc.loca.lt）：' -ForegroundColor Cyan
  $publicHost = Read-Host '  HUANTU_PUBLIC_HOST'
}
if (-not $publicHost) {
  Write-Host '  没有域名就无法通过外部 Host 校验，已退出。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}
$env:HUANTU_PUBLIC_HOST = $publicHost
$env:HUANTU_PUBLIC = '1'

# ---- 监听地址：默认只绑本机（配合隧道）；云服务器需要显式改成 0.0.0.0 ----
if (-not $env:HUANTU_BIND_HOST) { $env:HUANTU_BIND_HOST = '127.0.0.1' }
if (-not $env:HUANTU_MAX_CALLS) { $env:HUANTU_MAX_CALLS = '8' }
if (-not $env:HUANTU_AUTO_VERIFY) { $env:HUANTU_AUTO_VERIFY = '1' }

Write-Host ''
Write-Host '  寰途 · 公开试用模式' -ForegroundColor DarkGreen
Write-Host "  本机地址   http://127.0.0.1:$port" -ForegroundColor DarkGray
Write-Host "  访客地址   https://$publicHost" -ForegroundColor DarkGray
Write-Host "  监听       $($env:HUANTU_BIND_HOST):$port" -ForegroundColor DarkGray
Write-Host "  每个访客最多 $($env:HUANTU_MAX_CALLS) 次模型调用" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  提醒：' -ForegroundColor Yellow
Write-Host '  1) 访问码只在服务端内存里比对，不会写日志、不会进前端存储。' -ForegroundColor DarkGray
Write-Host '  2) 必须通过 HTTPS 隧道或反向代理对外，不要直接暴露 http 端口。' -ForegroundColor DarkGray
Write-Host '  3) 若用隧道，先把隧道跑起来，再把它给的域名填到 HUANTU_PUBLIC_HOST。' -ForegroundColor DarkGray
Write-Host '     隧道示例：npx localtunnel --port 8788' -ForegroundColor DarkGray
Write-Host '               cloudflared tunnel --url http://127.0.0.1:8788' -ForegroundColor DarkGray
Write-Host ''

Start-Job -ScriptBlock {
  param($p)
  Start-Sleep -Seconds 2
  Start-Process "http://127.0.0.1:$p"
} -ArgumentList $port | Out-Null

& node server.mjs
