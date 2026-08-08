[CmdletBinding()]
param(
  [string]$SearchRoot = (Join-Path $PSScriptRoot '..\out\builder')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SearchRoot -PathType Container)) {
  throw "Windows release output directory does not exist: $SearchRoot"
}

$expectedThumbprint = ($env:WINDOWS_SIGNER_THUMBPRINT -replace '\s', '').ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace($expectedThumbprint)) {
  throw 'WINDOWS_SIGNER_THUMBPRINT is required for final Windows signature verification.'
}
if ($expectedThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw 'WINDOWS_SIGNER_THUMBPRINT must be a 40-character certificate thumbprint.'
}

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signTool) {
  $signToolPath = Get-ChildItem -Path 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if ($signToolPath) { $signTool = Get-Command $signToolPath }
}
if (-not $signTool) {
  throw 'signtool.exe is required for final Windows signature verification.'
}

$artifacts = Get-ChildItem -LiteralPath $SearchRoot -Recurse -File |
  Where-Object {
    $_.Name -match '^LoomTV-[^/]+\.(exe|msi)$'
  } |
  Sort-Object FullName

if (-not $artifacts -or $artifacts.Count -eq 0) {
  throw "No final LoomTV Windows installer was found under $SearchRoot"
}

foreach ($artifact in $artifacts) {
  Write-Host "==> Verifying Authenticode signature: $($artifact.FullName)"
  & $signTool.Source verify /pa /all /tw $artifact.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "signtool verification failed for $($artifact.FullName)"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode status is $($signature.Status) for $($artifact.FullName)"
  }
  if (-not $signature.SignerCertificate) {
    throw "No signer certificate was found for $($artifact.FullName)"
  }
  $actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
  if ($actualThumbprint -ne $expectedThumbprint) {
    throw "Signer thumbprint mismatch for $($artifact.FullName): expected $expectedThumbprint, found $actualThumbprint"
  }
}

Write-Host "All $($artifacts.Count) Windows release installers are Authenticode-signed by $expectedThumbprint."
