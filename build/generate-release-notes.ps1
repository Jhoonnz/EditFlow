param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$catalogPath = Join-Path $repositoryRoot 'src/data/release-notes.json'
$normalizedVersion = $Version.Trim().TrimStart('v')
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$release = $catalog | Where-Object { $_.version -eq $normalizedVersion } | Select-Object -First 1

if (-not $release) {
  throw "No patch notes found for version $normalizedVersion in $catalogPath"
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("# $($release.title)")
$lines.Add('')
$lines.Add([string]$release.summary)
$lines.Add('')

foreach ($section in $release.sections) {
  $lines.Add("## $($section.title)")
  $lines.Add('')
  foreach ($item in $section.items) {
    $lines.Add("- $item")
  }
  $lines.Add('')
}

$targetDirectory = Split-Path -Parent $OutputPath
if ($targetDirectory) {
  New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
}

Set-Content -LiteralPath $OutputPath -Value $lines -Encoding UTF8
Write-Host "Generated release notes for EditFlow $normalizedVersion at $OutputPath"
