param(
  [string]$SourceUrl,
  [string]$FallbackUrl,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
}

$root = Split-Path -Parent $PSScriptRoot
$sourcesDir = Join-Path $root "sources"
$archivePath = Join-Path $sourcesDir "xfoil.tgz"
$sourcesPath = Join-Path $root "SOURCES.md"

New-Item -ItemType Directory -Force -Path $sourcesDir | Out-Null

$primary = $SourceUrl
if ([string]::IsNullOrWhiteSpace($primary)) {
  $primary = $env:XFOIL_URL
}
if ([string]::IsNullOrWhiteSpace($primary)) {
  $primary = "https://web.mit.edu/drela/Public/web/xfoil/xfoil6.996.tgz"
}

$fallback = $FallbackUrl
if ([string]::IsNullOrWhiteSpace($fallback)) {
  $fallback = $env:XFOIL_URL_FALLBACK
}
if ([string]::IsNullOrWhiteSpace($fallback)) {
  $fallback = "https://web.mit.edu/drela/Public/web/xfoil/xfoil6.99.tgz"
}

function Update-SourcesFile {
  param(
    [string]$SourceUrl,
    [string]$Sha256
  )

  $sourcesPath = Join-Path $root "SOURCES.md"
  if (-not (Test-Path $sourcesPath)) {
    return
  }

  $content = Get-Content -Path $sourcesPath -Raw
  $updated = $content
  $updated = [regex]::Replace($updated, '(?m)^- XFOIL source URL:.*$', "- XFOIL source URL: $SourceUrl")
  $updated = [regex]::Replace($updated, '(?m)^- XFOIL source SHA256:.*$', "- XFOIL source SHA256: $Sha256")

  if ($updated -ne $content) {
    Set-Content -Path $sourcesPath -Value $updated -Encoding ASCII
  }
}

function Download {
  param([string]$Url)
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $archivePath -UseBasicParsing
}

if (-not $Force -and (Test-Path $archivePath)) {
  $recordedUrl = $null
  $recordedSha = $null
  if (Test-Path $sourcesPath) {
    $content = Get-Content -Path $sourcesPath -Raw
    if ($content -match '(?m)^- XFOIL source URL:\s*(.+)$') {
      $recordedUrl = $Matches[1].Trim()
    }
    if ($content -match '(?m)^- XFOIL source SHA256:\s*(.+)$') {
      $recordedSha = $Matches[1].Trim()
    }
  }

  $hash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
  if ($recordedSha -and $hash -eq $recordedSha) {
    Write-Host "XFOIL sources already present at $archivePath. Use -Force to refresh."
    if ($recordedUrl) {
      Update-SourcesFile -SourceUrl $recordedUrl -Sha256 $hash
    }
    return
  }
}

if (Test-Path $archivePath) {
  Remove-Item -Path $archivePath -Force
}

$selected = $null
try {
  Download -Url $primary
  $selected = $primary
} catch {
  Write-Warning "Primary download failed: $($_.Exception.Message)"
  if ($fallback -and $fallback -ne $primary) {
    Download -Url $fallback
    $selected = $fallback
  }
}

if (-not $selected) {
  throw "Failed to download XFOIL sources."
}

$hash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
Update-SourcesFile -SourceUrl $selected -Sha256 $hash

Write-Host "Downloaded $selected"
Write-Host "SHA256: $hash"
