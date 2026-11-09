# Builds dist\Frame.exe (installer + launcher) and dist\frame-app.zip (update package).
# Usage:  powershell -ExecutionPolicy Bypass -File build\build.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$ver = (Get-Content (Join-Path $Root 'version.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem, System.Drawing

# start.bat must have Windows line endings
$bat = Join-Path $Root 'start.bat'
$txt = [IO.File]::ReadAllText($bat) -replace "`r?`n", "`r`n"
[IO.File]::WriteAllText($bat, $txt, (New-Object Text.ASCIIEncoding))

# ---- 1. App package (embedded in Frame.exe; the update zip adds the launcher on top) -----------
$zipPath = Join-Path $dist 'payload.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }
$fs = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
$zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
foreach ($inc in @('app', 'server', 'version.json', 'start.bat', 'README.md', '.env.example')) {
  $p = Join-Path $Root $inc
  $files = if (Test-Path $p -PathType Container) { Get-ChildItem $p -Recurse -File } elseif (Test-Path $p) { @(Get-Item $p) } else { @() }
  foreach ($f in $files) {
    if ($f.FullName -match '\\_test\\') { continue }
    $rel = $f.FullName.Substring($Root.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
}
$zip.Dispose(); $fs.Dispose()
Write-Host "Package: $zipPath ($([math]::Round((Get-Item $zipPath).Length / 1KB)) KB)"

# ---- 2. Icon (drawn in code, multi-size PNG .ico) ------------------------------------------------
function New-IconPng([int]$s) {
  $bmp = New-Object Drawing.Bitmap $s, $s
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::Transparent)
  $r = [int]($s * 0.22); $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90); $path.AddArc($s - $r * 2 - 1, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($s - $r * 2 - 1, $s - $r * 2 - 1, $r * 2, $r * 2, 0, 90); $path.AddArc(0, $s - $r * 2 - 1, $r * 2, $r * 2, 90, 90); $path.CloseFigure()
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush((New-Object Drawing.Point 0, 0), (New-Object Drawing.Point $s, $s), [Drawing.Color]::FromArgb(255, 139, 92, 246), [Drawing.Color]::FromArgb(255, 34, 211, 238))
  $blend = New-Object Drawing.Drawing2D.ColorBlend 3
  $blend.Colors = @([Drawing.Color]::FromArgb(255, 139, 92, 246), [Drawing.Color]::FromArgb(255, 99, 102, 241), [Drawing.Color]::FromArgb(255, 34, 211, 238)); $blend.Positions = @(0.0, 0.5, 1.0)
  $brush.InterpolationColors = $blend
  $g.FillPath($brush, $path)
  $tri = @((New-Object Drawing.PointF ($s * 0.38), ($s * 0.27)), (New-Object Drawing.PointF ($s * 0.76), ($s * 0.5)), (New-Object Drawing.PointF ($s * 0.38), ($s * 0.73)))
  $g.FillPolygon([Drawing.Brushes]::White, $tri)
  $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  return , $ms.ToArray()
}
$sizes = @(256, 64, 48, 32, 16); $pngs = $sizes | ForEach-Object { , (New-IconPng $_) }
$ico = Join-Path $PSScriptRoot 'frame.ico'
$out = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]; $len = $pngs[$i].Length
  $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset); $offset += $len
}
foreach ($p in $pngs) { $w.Write([byte[]]$p) }
$w.Flush(); [IO.File]::WriteAllBytes($ico, $out.ToArray())
# Favicon for the web app too
[IO.File]::WriteAllBytes((Join-Path $Root 'app\favicon.png'), [byte[]]$pngs[1])

# ---- 3. Compile the launcher --------------------------------------------------------------------
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$fw = Split-Path $csc
$src = Join-Path $env:TEMP "frame-launcher-$ver.cs"
(Get-Content (Join-Path $PSScriptRoot 'launcher.cs') -Raw).Replace('%VERSION%', $ver) | Set-Content $src -Encoding UTF8
$exe = Join-Path $dist 'Frame.exe'
$wv = Join-Path $PSScriptRoot 'webview2'
& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" "/win32icon:$ico" "/resource:$zipPath,payload.zip" `
  "/resource:$wv\Microsoft.Web.WebView2.Core.dll,Microsoft.Web.WebView2.Core.dll" "/resource:$wv\Microsoft.Web.WebView2.WinForms.dll,Microsoft.Web.WebView2.WinForms.dll" "/resource:$wv\WebView2Loader.dll,WebView2Loader.dll" `
  "/r:$fw\System.IO.Compression.dll" "/r:$fw\System.IO.Compression.FileSystem.dll" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.dll `
  "/r:$wv\Microsoft.Web.WebView2.Core.dll" "/r:$wv\Microsoft.Web.WebView2.WinForms.dll" $src
if ($LASTEXITCODE -ne 0) { throw 'Compile failed' }
Remove-Item $src

# ---- 4. Update package = app package + the new launcher -----------------------------------------
$upd = Join-Path $dist 'frame-app.zip'
Copy-Item $zipPath $upd -Force
$z = [IO.Compression.ZipFile]::Open($upd, [IO.Compression.ZipArchiveMode]::Update)
[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $exe, 'launcher/Frame.exe', [IO.Compression.CompressionLevel]::Optimal) | Out-Null
$z.Dispose()
Write-Host "Built: $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB) and $upd ($([math]::Round((Get-Item $upd).Length / 1KB)) KB) - version $ver" -ForegroundColor Green
