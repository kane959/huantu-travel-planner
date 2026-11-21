# 寰途｜AI 智能旅行策划师 · 本机启动
# 用法：右键「使用 PowerShell 运行」，或在终端执行 .\启动寰途.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = if ($env:HUANTU_PORT) { $env:HUANTU_PORT } else { 8788 }
$url = "http://127.0.0.1:$port"

Write-Host ''
Write-Host '  寰途 · AI 智能旅行策划师' -ForegroundColor DarkGreen
Write-Host "  $url" -ForegroundColor DarkGray
Write-Host ''

# 若端口已被占用，说明服务已在运行，直接打开页面
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "  端口 $port 已在监听，直接打开页面。" -ForegroundColor Yellow
  Start-Process $url
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  未找到 Node.js。请先安装 Node.js 22 或更高版本，再运行本脚本。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

$version = (& node -v) -replace '^v', ''
$major = [int]($version.Split('.')[0])
if ($major -lt 22) {
  Write-Host "  当前 Node.js 版本为 $version，需要 22 或更高版本。" -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

Start-Job -ScriptBlock {
  param($p)
  Start-Sleep -Seconds 2
  Start-Process "http://127.0.0.1:$p"
} -ArgumentList $port | Out-Null

Write-Host '  提示：模型密钥只在后端内存中，关闭窗口后需在设置页重新填写。' -ForegroundColor DarkGray
Write-Host '  如需让别人通过公网访问，请改用 .\启动-公网试用.ps1（带访问码）。' -ForegroundColor DarkGray
Write-Host ''

& node server.mjs
