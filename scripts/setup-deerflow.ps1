param(
  [string]$RepoUrl = "https://github.com/stophobia/deerflow2.0-enhanced.git",
  [string]$ZipUrl = "https://codeload.github.com/stophobia/deerflow2.0-enhanced/zip/refs/heads/main",
  [string]$ToolsDir = ".tools"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path ".").Path
$toolsPath = Join-Path $root $ToolsDir
$zipPath = Join-Path $toolsPath "deerflow2-enhanced.zip"
$extractRoot = Join-Path $toolsPath "deerflow2-enhanced-src"
$sourcePath = Join-Path $extractRoot "deerflow2.0-enhanced-main"

New-Item -ItemType Directory -Force -Path $toolsPath | Out-Null

if (-not (Test-Path $sourcePath)) {
  $clonePath = Join-Path $toolsPath "deerflow2-enhanced"
  try {
    git clone $RepoUrl $clonePath
    $sourcePath = $clonePath
  } catch {
    if (Test-Path $clonePath) {
      Remove-Item -LiteralPath $clonePath -Recurse -Force
    }
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath
    if (Test-Path $extractRoot) {
      Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
  }
}

foreach ($pair in @(
  @("config.example.yaml", "config.yaml"),
  @(".env.example", ".env"),
  @("frontend\.env.example", "frontend\.env")
)) {
  $from = Join-Path $sourcePath $pair[0]
  $to = Join-Path $sourcePath $pair[1]
  if ((Test-Path $from) -and -not (Test-Path $to)) {
    Copy-Item -LiteralPath $from -Destination $to
  }
}

Write-Host "DeerFlow source is ready at: $sourcePath"
Write-Host "Next: install Python 3.12/3.13 and pnpm, then run uv sync and pnpm install inside DeerFlow."
