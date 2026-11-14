#requires -Version 5.1
<#
.SYNOPSIS
  一键打包 dsh-agent-session-tools，产出可 `dsh plugin add` 的 tgz。
.DESCRIPTION
  - 检查 Node.js 版本
  - 用 scripts/build.mjs 构建（无需本地安装依赖：脚本把 typescript 与
    @deepseek-ai 类型包从 DSH checkout / 兄弟项目链接进本目录 node_modules
    垫片；可用 $DSH_NODE_MODULES 或 $DSH_HOME 指定来源）
  - 跑一遍 vitest（可用 -SkipTests 跳过）
  - npm pack 到 release/，校验 tarball 只含运行文件
  - 生成 SHA256SUMS.txt 并打印安装命令
.PARAMETER OutDir
  输出目录，默认 release。
.PARAMETER SkipTests
  跳过测试。
.PARAMETER KeepOutDir
  保留输出目录里的旧文件（默认先清空）。
#>
[CmdletBinding()]
param(
  [string]$OutDir = "release",
  [switch]$SkipTests,
  [switch]$KeepOutDir
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$errFile = Join-Path $env:TEMP ("dsh-pack-" + [Guid]::NewGuid().ToString("N") + ".log")
Push-Location $root
try {
  $pkg = Get-Content -Raw -Encoding UTF8 "package.json" | ConvertFrom-Json
  Write-Host "==> $($pkg.name) pack" -ForegroundColor Cyan
  Write-Host "    version: $($pkg.version)"

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "未找到 Node.js，请安装 Node.js >= 22.19.0。" }
  $nodeVersion = (& node --version).Trim()
  if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw "需要 Node.js >= 22.19.0，当前为 $nodeVersion。" }
  Write-Host "    node: $nodeVersion"

  function Invoke-Step {
    param([string]$Label, [scriptblock]$Body)
    Write-Host "==> $Label"
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & $Body 2> $errFile
    $code = $LASTEXITCODE
    $ErrorActionPreference = $saved
    if ($code -ne 0) {
      if ($out) { $out | Write-Host }
      Get-Content $errFile -ErrorAction SilentlyContinue | Write-Host
      throw "$Label 失败（exit $code）。"
    }
    return $out
  }

  Invoke-Step "build (tsc -p tsconfig.build.json)" { node scripts/build.mjs tsconfig.build.json } | Out-Null
  if (-not $SkipTests) {
    # build.mjs leaves a vitest link in the local shim when a deps root was found.
    $vitest = Join-Path $root "node_modules\.bin\vitest.cmd"
    if (-not (Test-Path $vitest)) { $vitest = "npx" }
    if ($vitest -eq "npx") { Invoke-Step "test (npx vitest run)" { npx vitest run --config vitest.config.ts } | Out-Null }
    else { Invoke-Step "test (vitest run)" { & $vitest run --config vitest.config.ts } | Out-Null }
  }

  if (Test-Path $OutDir) {
    if (-not $KeepOutDir) { Remove-Item -Recurse -Force $OutDir }
  }
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  $packOutput = Invoke-Step "npm pack" { npm pack --ignore-scripts --pack-destination $OutDir }
  $tgzName = ($packOutput | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1)
  if (-not $tgzName) { throw "npm pack 未返回 tarball 文件名。" }
  $tgz = Join-Path $OutDir $tgzName.Trim()
  if (-not (Test-Path $tgz)) { throw "tarball 不存在：$tgz" }

  Write-Host "==> 校验 tarball 内容"
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $entries = @(& tar -tzf $tgz 2> $errFile)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($code -ne 0) { Get-Content $errFile -ErrorAction SilentlyContinue | Write-Host; throw "tar 无法读取 $tgz。" }
  foreach ($item in @("package/package.json", "package/cordis.patch.yml", "package/cordis.yml")) {
    if (-not ($entries -contains $item)) { throw "tarball 缺少 $item。" }
  }
  foreach ($item in @("package/dist/index.js", "package/dist/session-tools.js", "package/dist/checks.js")) {
    if (-not ($entries -contains $item)) { throw "tarball 缺少 $item，构建可能失败。" }
  }
  $forbidden = @($entries | Where-Object { $_ -match '^package/(src|tests|scripts|node_modules|release)/' })
  if ($forbidden.Count -gt 0) {
    throw ("tarball 含不应发布的路径：" + [Environment]::NewLine + ($forbidden -join [Environment]::NewLine))
  }
  Write-Host "    entries: $($entries.Count)"

  $hash = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLowerInvariant()
  $sumFile = Join-Path $OutDir "SHA256SUMS.txt"
  "$hash  $($tgzName.Trim())" | Set-Content -Encoding ASCII $sumFile

  $full = (Resolve-Path $tgz).Path
  Write-Host ""
  Write-Host "==> 完成" -ForegroundColor Green
  Write-Host ("    tarball: $full ({0} KB)" -f [math]::Round((Get-Item $tgz).Length / 1KB, 1))
  Write-Host "    sha256 : $hash"
  Write-Host ""
  Write-Host "安装方式（需重启 DSH）：" -ForegroundColor Cyan
  Write-Host "    dsh plugin --profile <profile> add $full"
} finally {
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  Pop-Location
}
