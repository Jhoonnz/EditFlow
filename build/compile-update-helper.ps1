$ErrorActionPreference = 'Stop'

$buildDirectory = $PSScriptRoot
$sourcePath = Join-Path $buildDirectory 'update-helper.cs'
$outputPath = Join-Path $buildDirectory 'EditFlowUpdateHelper.exe'
$windowsDirectory = [Environment]::GetFolderPath('Windows')
$compilerCandidates = @(
  (Join-Path $windowsDirectory 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $windowsDirectory 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ([string]::IsNullOrWhiteSpace($compilerPath)) {
  throw 'Não foi possível localizar o compilador .NET Framework necessário para gerar o auxiliar de atualização.'
}

& $compilerPath `
  /nologo `
  /target:winexe `
  /optimize+ `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  "/out:$outputPath" `
  $sourcePath

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
  throw "Falha ao compilar o auxiliar de atualização (código $LASTEXITCODE)."
}
