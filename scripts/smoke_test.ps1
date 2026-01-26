$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $root "tools\smoke_test.js"

if (-not (Test-Path $scriptPath)) {
  Write-Error "Missing tools/smoke_test.js. Verify the repository layout."
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
