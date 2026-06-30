$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }

    $parts = $line -split '=', 2
    if ($parts.Count -eq 2) {
      [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
    }
  }
}

if ([string]::IsNullOrWhiteSpace($env:ADMIN_TOKEN)) {
  throw 'set ADMIN_TOKEN in .env or environment'
}

if ([string]::IsNullOrWhiteSpace($env:MASTER_KEY)) {
  $env:MASTER_KEY = ''
}
if ([string]::IsNullOrWhiteSpace($env:LISTEN_ADDR)) {
  $env:LISTEN_ADDR = '0.0.0.0:8080'
}
if ([string]::IsNullOrWhiteSpace($env:STATIC_DIR)) {
  $env:STATIC_DIR = './static'
}
if ([string]::IsNullOrWhiteSpace($env:DB_DSN)) {
  $env:DB_DSN = 'sqlite://./data/little_gate.sqlite'
}
if ([string]::IsNullOrWhiteSpace($env:RUST_LOG)) {
  $env:RUST_LOG = 'info'
}

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data') | Out-Null

& (Join-Path $PSScriptRoot 'little-gate.exe')
exit $LASTEXITCODE
