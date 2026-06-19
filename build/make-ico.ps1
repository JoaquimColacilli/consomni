# Genera un .ico multi-resolución (PNG-in-ICO, soportado en Vista+) desde un PNG fuente.
param(
  [string]$Src = "$PSScriptRoot\icon.png",
  [string]$Out = "$PSScriptRoot\icon.ico"
)
Add-Type -AssemblyName System.Drawing
$sizes = @(256,128,64,48,32,24,16)
$img = [System.Drawing.Image]::FromFile($Src)

$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $pngs += ,@{ size = $s; bytes = $ms.ToArray() }
  $ms.Dispose()
}
$img.Dispose()

$fs = New-Object System.IO.FileStream($Out, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
# ICONDIR
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type = icon
$bw.Write([UInt16]$pngs.Count)       # count
$offset = 6 + (16 * $pngs.Count)
foreach ($p in $pngs) {
  $dim = $p.size; if ($dim -ge 256) { $dim = 0 }
  $bw.Write([Byte]$dim)              # width  (0 = 256)
  $bw.Write([Byte]$dim)              # height (0 = 256)
  $bw.Write([Byte]0)                 # palette
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # color planes
  $bw.Write([UInt16]32)              # bits per pixel
  $bw.Write([UInt32]$p.bytes.Length) # bytes in resource
  $bw.Write([UInt32]$offset)         # offset
  $offset += $p.bytes.Length
}
foreach ($p in $pngs) { $bw.Write($p.bytes) }
$bw.Flush(); $bw.Close(); $fs.Close()
Write-Output ("OK {0} ({1} bytes, {2} sizes)" -f $Out, (Get-Item $Out).Length, $pngs.Count)
