param(
  [string]$SourcePath = (Join-Path $PSScriptRoot 'editflow-icon-approved-reference.png'),
  [string]$OutputPath = (Join-Path $PSScriptRoot 'editflow-icon-source.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Approved icon reference not found: $SourcePath"
}

if (-not ('EditFlowIconFlattener' -as [type])) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;

public static class EditFlowIconFlattener
{
    private static bool InsideRoundedRectangle(int x, int y, int width, int height, int inset = 0)
    {
        double scaleX = width / 1254.0;
        double scaleY = height / 1254.0;
        int left = (int)Math.Round(38 * scaleX) + inset;
        int top = (int)Math.Round(36 * scaleY) + inset;
        int right = (int)Math.Round(1217 * scaleX) - inset;
        int bottom = (int)Math.Round(1219 * scaleY) - inset;
        int radiusX = Math.Max(1, (int)Math.Round(190 * scaleX) - inset);
        int radiusY = Math.Max(1, (int)Math.Round(190 * scaleY) - inset);

        if (x < left || x > right || y < top || y > bottom) return false;
        if (x >= left + radiusX && x <= right - radiusX) return true;
        if (y >= top + radiusY && y <= bottom - radiusY) return true;

        double centerX = x < left + radiusX ? left + radiusX : right - radiusX;
        double centerY = y < top + radiusY ? top + radiusY : bottom - radiusY;
        double normalizedX = (x - centerX) / radiusX;
        double normalizedY = (y - centerY) / radiusY;
        return (normalizedX * normalizedX) + (normalizedY * normalizedY) <= 1.0;
    }

    public static void Flatten(string sourcePath, string outputPath)
    {
        using (var source = new Bitmap(sourcePath))
        using (var output = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        {
            Color background = Color.FromArgb(255, 103, 93, 206);
            Color ribbon = Color.FromArgb(255, 185, 178, 255);
            Color white = Color.FromArgb(255, 255, 255, 255);
            Color transparent = Color.FromArgb(0, 0, 0, 0);

            for (int y = 0; y < source.Height; y++)
            {
                for (int x = 0; x < source.Width; x++)
                {
                    if (!InsideRoundedRectangle(x, y, source.Width, source.Height))
                    {
                        output.SetPixel(x, y, transparent);
                        continue;
                    }

                    Color pixel = source.GetPixel(x, y);
                    bool isOuterEdge = !InsideRoundedRectangle(
                        x,
                        y,
                        source.Width,
                        source.Height,
                        Math.Max(18, (int)Math.Round(source.Width / 68.0))
                    );
                    bool isWhite = pixel.R >= 225 && pixel.G >= 225 && pixel.B >= 225;
                    bool isRibbon = !isWhite
                        && pixel.R >= 140
                        && pixel.B >= 195
                        && pixel.B - pixel.R < 90;

                    output.SetPixel(x, y, isOuterEdge ? background : isWhite ? white : isRibbon ? ribbon : background);
                }
            }

            output.Save(outputPath, ImageFormat.Png);
        }
    }
}
'@
}

[EditFlowIconFlattener]::Flatten(
  (Resolve-Path -LiteralPath $SourcePath).Path,
  [System.IO.Path]::GetFullPath($OutputPath)
)

Write-Host "Generated flat EditFlow icon source at $OutputPath"
