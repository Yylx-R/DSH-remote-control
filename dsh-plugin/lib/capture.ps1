param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 3840,
  [int]$Quality = 90,
  [string]$Target = 'primary'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$all = [System.Windows.Forms.Screen]::AllScreens
$primary = [System.Windows.Forms.Screen]::PrimaryScreen
$secondary = $all | Where-Object { -not $_.Primary } | Select-Object -First 1

switch ($Target) {
  'secondary' {
    if (-not $secondary) { throw 'NO_SECONDARY' }
    $bounds = $secondary.Bounds
  }
  'all' {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  }
  default {
    $bounds = $primary.Bounds
  }
}

$src = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($src)
try {
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $src.Size)
} finally {
  $g.Dispose()
}

$w = [Math]::Min($MaxWidth, $bounds.Width)
if ($w -lt 200) { $w = $bounds.Width }
$h = [int][Math]::Round($bounds.Height * ($w / $bounds.Width))

$dst = New-Object System.Drawing.Bitmap($w, $h)
$g2 = [System.Drawing.Graphics]::FromImage($dst)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $w, $h)
$g2.Dispose()
$src.Dispose()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$dst.Save($Out, $codec, $ep)
$dst.Dispose()

$screens = @($all | ForEach-Object {
    [pscustomobject]@{ primary = [bool]$_.Primary; width = $_.Bounds.Width; height = $_.Bounds.Height }
  })

Write-Output (ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
      width   = $w
      height  = $h
      target  = $Target
      screens = $screens
    }))
