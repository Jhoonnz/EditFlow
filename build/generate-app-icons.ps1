param(
  [string]$SourcePath = (Join-Path $PSScriptRoot 'editflow-icon-source.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Icon source not found: $SourcePath"
}

function New-ResizedPngBytes {
  param(
    [System.Drawing.Image]$Source,
    [int]$Size
  )

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))

  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()

  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  return $bytes
}

function Write-Bytes {
  param(
    [byte[]]$Bytes,
    [string]$Destination
  )

  [System.IO.File]::WriteAllBytes($Destination, $Bytes)
}

$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourcePath))
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$representations = foreach ($size in $sizes) {
  [pscustomobject]@{
    Size = $size
    Data = New-ResizedPngBytes -Source $source -Size $size
  }
}

Write-Bytes -Bytes (New-ResizedPngBytes -Source $source -Size 512) -Destination (Join-Path $PSScriptRoot 'editflow-icon.png')
Write-Bytes -Bytes (($representations | Where-Object Size -eq 16).Data) -Destination (Join-Path $PSScriptRoot 'editflow-tray.png')
Write-Bytes -Bytes (($representations | Where-Object Size -eq 32).Data) -Destination (Join-Path $PSScriptRoot 'editflow-tray@2x.png')

$iconPath = Join-Path $PSScriptRoot 'editflow-icon.ico'
$stream = [System.IO.File]::Create($iconPath)
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$representations.Count)

$offset = 6 + (16 * $representations.Count)
foreach ($representation in $representations) {
  $dimension = if ($representation.Size -eq 256) { 0 } else { $representation.Size }
  $writer.Write([byte]$dimension)
  $writer.Write([byte]$dimension)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$representation.Data.Length)
  $writer.Write([uint32]$offset)
  $offset += $representation.Data.Length
}

foreach ($representation in $representations) {
  $writer.Write([byte[]]$representation.Data)
}

$writer.Dispose()
$stream.Dispose()
$source.Dispose()

Write-Host "Generated EditFlow app and tray icons from $SourcePath"
