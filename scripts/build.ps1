$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $root "tools\build.js"

if (-not (Test-Path $scriptPath)) {
  Write-Error "Missing tools/build.js. Verify the repository layout."
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found. Install Node.js and retry."
  exit 1
}

& node $scriptPath @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
