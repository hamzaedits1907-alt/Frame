# Frame - local server
# Serves the editor UI, proxies the NVIDIA AI API (so your key never hits a browser CORS wall),
# and muxes exports with FFmpeg. Listens on localhost only.
param(
  [int]$Port = 4719,
  [switch]$Open
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root      = Split-Path $PSScriptRoot -Parent
$AppDir    = [IO.Path]::GetFullPath((Join-Path $Root 'app'))
$ExportDir = Join-Path $Root 'exports'
# Installed copies (Frame.exe) save exports in the user's Videos folder.
if ($env:LOCALAPPDATA -and $Root.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) { $ExportDir = Join-Path ([Environment]::GetFolderPath('MyVideos')) 'Frame' }
$TmpDir    = Join-Path $Root '.frame-tmp'
$script:RestartCode = 0

# ---- Version / update source -------------------------------------------------------------------
$script:Version = '0.0.0'; $script:Repo = ''
$vf = Join-Path $Root 'version.json'
if (Test-Path $vf) { try { $vj = Get-Content $vf -Raw | ConvertFrom-Json; $script:Version = [string]$vj.version; $script:Repo = [string]$vj.repo } catch { } }
function Compare-Version($a, $b) {
  $pa = ($a -replace '^v', '').Split('.') | ForEach-Object { [int]($_ -replace '\D', '0') }
  $pb = ($b -replace '^v', '').Split('.') | ForEach-Object { [int]($_ -replace '\D', '0') }
  for ($i = 0; $i -lt 3; $i++) { $x = $(if ($i -lt $pa.Count) { $pa[$i] } else { 0 }); $y = $(if ($i -lt $pb.Count) { $pb[$i] } else { 0 }); if ($x -ne $y) { return [Math]::Sign($x - $y) } }
  return 0
}
function Get-LatestRelease {
  # FRAME_UPDATE_FEED (a local release JSON file) lets the updater be tested offline.
  if ($env:FRAME_UPDATE_FEED -and (Test-Path $env:FRAME_UPDATE_FEED)) {
    $json = Get-Content $env:FRAME_UPDATE_FEED -Raw | ConvertFrom-Json
    $asset = $json.assets | Where-Object { $_.name -eq 'frame-app.zip' } | Select-Object -First 1
    return @{ tag = ($json.tag_name -replace '^v', ''); notes = [string]$json.body; url = $(if ($asset) { $asset.browser_download_url } else { $null }) }
  }
  if (-not $script:Repo) { throw 'No update source is configured for this copy of Frame.' }
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "https://api.github.com/repos/$($script:Repo)/releases/latest")
  $req.Headers.UserAgent.ParseAdd('Frame-Updater')
  $req.Headers.Accept.ParseAdd('application/vnd.github+json')
  $resp = $Http.SendAsync($req).GetAwaiter().GetResult()
  if ([int]$resp.StatusCode -eq 404) { throw 'No releases published yet.' }
  if (-not $resp.IsSuccessStatusCode) { throw "GitHub answered $([int]$resp.StatusCode)" }
  $json = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
  $asset = $json.assets | Where-Object { $_.name -eq 'frame-app.zip' } | Select-Object -First 1
  return @{ tag = ($json.tag_name -replace '^v', ''); notes = [string]$json.body; url = $(if ($asset) { $asset.browser_download_url } else { $null }) }
}
function Install-Update {
  $rel = Get-LatestRelease
  if (-not $rel.url) { throw 'The latest release has no frame-app.zip file.' }
  $dir = Join-Path $TmpDir ('update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $dir | Out-Null
  $zip = Join-Path $dir 'frame-app.zip'
  if (Test-Path -LiteralPath $rel.url) { Copy-Item -LiteralPath $rel.url $zip }
  else {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $rel.url)
    $req.Headers.UserAgent.ParseAdd('Frame-Updater')
    $resp = $Http.SendAsync($req).GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) { throw "Download failed ($([int]$resp.StatusCode))" }
    [IO.File]::WriteAllBytes($zip, $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $out = Join-Path $dir 'files'
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $out)
  if (-not (Test-Path (Join-Path $out 'app\index.html'))) { throw 'The update package looks broken.' }
  # Replace program files (user data lives in the browser and in .env / exports, which are kept).
  foreach ($item in Get-ChildItem $out) {
    $dest = Join-Path $Root $item.Name
    if ($item.PSIsContainer) {
      if (Test-Path $dest) { Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue }
      Copy-Item -Recurse -Force $item.FullName $dest
    } else { Copy-Item -Force $item.FullName $dest }
  }
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  return $rel.tag
}
$Origin    = "http://localhost:$Port"
$NvidiaBase = 'https://integrate.api.nvidia.com/v1'

New-Item -ItemType Directory -Force $ExportDir | Out-Null
New-Item -ItemType Directory -Force $TmpDir | Out-Null

# ---- Config: NVIDIA key from environment or .env ---------------------------------------------
$script:EnvKey = $env:NVIDIA_API_KEY
$script:GeminiKey = $env:GEMINI_API_KEY
if (-not $script:GeminiKey) { $script:GeminiKey = $env:GOOGLE_API_KEY }
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if (-not $script:EnvKey -and $line -match '^\s*NVIDIA_API_KEY\s*=\s*"?([^"]+?)"?\s*$') { $script:EnvKey = $Matches[1] }
    if (-not $script:GeminiKey -and $line -match '^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*"?([^"]+?)"?\s*$') { $script:GeminiKey = $Matches[2] }
  }
}

$script:Ffmpeg = $null
$cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($cmd) { $script:Ffmpeg = $cmd.Source }
elseif (Test-Path (Join-Path $Root 'tools\ffmpeg.exe')) { $script:Ffmpeg = Join-Path $Root 'tools\ffmpeg.exe' }

$Http = New-Object System.Net.Http.HttpClient
$Http.Timeout = [TimeSpan]::FromSeconds(100)

$Mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
  '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'; '.mp4' = 'video/mp4'; '.webm' = 'video/webm'; '.mp3' = 'audio/mpeg'
  '.wav' = 'audio/wav'; '.gif' = 'image/gif'; '.txt' = 'text/plain; charset=utf-8'
}

# ---- Helpers ----------------------------------------------------------------------------------
function Send-Bytes($ctx, [int]$status, [byte[]]$bytes, [string]$type) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.Headers['X-Content-Type-Options'] = 'nosniff'
  $res.ContentLength64 = $bytes.Length
  if ($bytes.Length -gt 0) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  $res.OutputStream.Close()
}
function Send-Json($ctx, [int]$status, $obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  Send-Bytes $ctx $status ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8'
}
function Read-Body($ctx) {
  $ms = New-Object IO.MemoryStream
  $ctx.Request.InputStream.CopyTo($ms)
  return ,$ms.ToArray()
}
function Get-Query($ctx, $name) { return $ctx.Request.QueryString[$name] }
function Safe-Id($s) { if ($s -match '^[A-Za-z0-9_-]{4,64}$') { return $s } else { throw 'bad id' } }
function Quote-Arg($a) { return '"' + ($a -replace '"', '\"') + '"' }

function Serve-Static($ctx) {
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
  $full = [IO.Path]::GetFullPath((Join-Path $AppDir ($path.TrimStart('/') -replace '/', '\')))
  if (-not $full.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    Send-Bytes $ctx 404 ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain'; return
  }
  $ext = [IO.Path]::GetExtension($full).ToLower()
  $type = $Mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
  Send-Bytes $ctx 200 ([IO.File]::ReadAllBytes($full)) $type
}

function Proxy-Nvidia($ctx, [string]$method, [string]$subPath, [byte[]]$body) {
  $key = $ctx.Request.Headers['X-NVIDIA-Key']
  if (-not $key) { $key = $script:EnvKey }
  if (-not $key) { Send-Json $ctx 401 @{ error = 'No NVIDIA API key. Open AI settings and paste your key from build.nvidia.com.' }; return }
  $m = if ($method -eq 'POST') { [System.Net.Http.HttpMethod]::Post } else { [System.Net.Http.HttpMethod]::Get }
  $req = New-Object System.Net.Http.HttpRequestMessage($m, "$NvidiaBase/$subPath")
  $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $key)
  $req.Headers.Accept.ParseAdd('application/json')
  if ($body) {
    $req.Content = New-Object System.Net.Http.ByteArrayContent(,$body)
    $req.Content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/json')
  }
  try {
    $resp = $Http.SendAsync($req).GetAwaiter().GetResult()
    $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    Send-Bytes $ctx ([int]$resp.StatusCode) $bytes 'application/json; charset=utf-8'
  } catch {
    Send-Json $ctx 502 @{ error = "Could not reach NVIDIA: $($_.Exception.InnerException.Message)$($_.Exception.Message)" }
  }
}

function Handle-Api($ctx) {
  $req = $ctx.Request
  $path = $req.Url.AbsolutePath
  $method = $req.HttpMethod

  # Only our own page may call the API (blocks other websites from using your key or disk).
  $origin = $req.Headers['Origin']
  if ($origin -and $origin -ne $Origin) { Send-Json $ctx 403 @{ error = 'forbidden origin' }; return }
  if ($method -eq 'POST' -and $req.Headers['X-Frame-Client'] -ne '1') { Send-Json $ctx 403 @{ error = 'missing client header' }; return }

  switch -Regex ($path) {
    '^/api/status$' {
      Send-Json $ctx 200 @{ ok = $true; version = $script:Version; ffmpeg = [bool]$script:Ffmpeg; envKey = [bool]$script:EnvKey; geminiEnv = [bool]$script:GeminiKey; exportDir = $ExportDir }
      return
    }
    '^/api/update/check$' {
      try {
        $rel = Get-LatestRelease
        Send-Json $ctx 200 @{ current = $script:Version; latest = $rel.tag; available = ((Compare-Version $rel.tag $script:Version) -gt 0 -and [bool]$rel.url); notes = $rel.notes }
      } catch { Send-Json $ctx 200 @{ current = $script:Version; latest = $script:Version; available = $false; error = $_.Exception.Message } }
      return
    }
    '^/api/update/apply$' {
      if ($method -ne 'POST') { Send-Json $ctx 405 @{ error = 'POST only' }; return }
      try {
        $tag = Install-Update
        Send-Json $ctx 200 @{ ok = $true; installed = $tag }
        Write-Host "Updated to $tag - restarting..." -ForegroundColor Green
        $script:RestartCode = 42
      } catch { Send-Json $ctx 500 @{ error = $_.Exception.Message } }
      return
    }
    '^/api/gemini-key$' { Send-Json $ctx 200 @{ key = $(if ($script:GeminiKey) { $script:GeminiKey } else { '' }) }; return }
    '^/api/ai/models$' { Proxy-Nvidia $ctx 'GET' 'models' $null; return }
    '^/api/ai/chat$' { Proxy-Nvidia $ctx 'POST' 'chat/completions' (Read-Body $ctx); return }
    '^/api/export/upload$' {
      $id = Safe-Id (Get-Query $ctx 'id'); $kind = Get-Query $ctx 'kind'
      if ($kind -notin @('video', 'audio')) { throw 'bad kind' }
      $dir = Join-Path $TmpDir $id; New-Item -ItemType Directory -Force $dir | Out-Null
      $file = Join-Path $dir ($(if ($kind -eq 'video') { 'video.h264' } else { 'audio.wav' }))
      $fs = [IO.File]::Open($file, [IO.FileMode]::Create)
      try { $req.InputStream.CopyTo($fs) } finally { $fs.Close() }
      Send-Json $ctx 200 @{ ok = $true }
      return
    }
    '^/api/export/finish$' {
      if (-not $script:Ffmpeg) { Send-Json $ctx 500 @{ error = 'FFmpeg not found. Install it (winget install Gyan.FFmpeg) and restart Frame.' }; return }
      $id = Safe-Id (Get-Query $ctx 'id')
      $fps = [double](Get-Query $ctx 'fps')
      $name = (Get-Query $ctx 'name') -replace '[^\p{L}\p{N} _\-\.\(\)]', '_'
      if (-not $name) { $name = 'Frame export' }
      $dir = Join-Path $TmpDir $id
      $v = Join-Path $dir 'video.h264'; $a = Join-Path $dir 'audio.wav'
      $stamp = Get-Date -Format 'yyyy-MM-dd HH-mm-ss'
      $format = Get-Query $ctx 'format'
      if ($format -notin @('mp4', 'gif', 'mp3', 'wav')) { $format = 'mp4' }
      $outName = "$name $stamp.$format"
      $out = Join-Path $ExportDir $outName
      $ffArgs = @('-y', '-hide_banner', '-loglevel', 'error')
      if ($format -eq 'mp3') { $ffArgs += @('-i', $a, '-c:a', 'libmp3lame', '-b:a', '192k', $out) }
      elseif ($format -eq 'wav') { $ffArgs += @('-i', $a, '-c:a', 'pcm_s16le', $out) }
      elseif ($format -eq 'gif') { $ffArgs += @('-fflags', '+genpts', '-r', "$fps", '-i', $v, '-vf', 'scale=''min(iw,720)'':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', $out) }
      else {
        $ffArgs += @('-fflags', '+genpts', '-r', "$fps", '-i', $v)
        if (Test-Path $a) { $ffArgs += @('-i', $a, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k') }
        $ffArgs += @('-c:v', 'copy', '-movflags', '+faststart', $out)
      }
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $script:Ffmpeg
      $psi.Arguments = ($ffArgs | ForEach-Object { Quote-Arg $_ }) -join ' '
      $psi.UseShellExecute = $false; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
      $p = [Diagnostics.Process]::Start($psi)
      $err = $p.StandardError.ReadToEnd(); $p.WaitForExit()
      Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
      if ($p.ExitCode -ne 0) { Send-Json $ctx 500 @{ error = "FFmpeg failed: $err" }; return }
      Send-Json $ctx 200 @{ ok = $true; file = $outName; path = $out }
      return
    }
    '^/api/export/file$' {
      $name = [IO.Path]::GetFileName((Get-Query $ctx 'name'))
      $full = Join-Path $ExportDir $name
      if (-not (Test-Path -LiteralPath $full)) { Send-Json $ctx 404 @{ error = 'not found' }; return }
      $ctx.Response.Headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + [Uri]::EscapeDataString($name)
      $fs = [IO.File]::OpenRead($full)
      try {
        $ctx.Response.StatusCode = 200; $ctx.Response.ContentType = $($Mime[[IO.Path]::GetExtension($full).ToLower()]); $ctx.Response.ContentLength64 = $fs.Length
        $fs.CopyTo($ctx.Response.OutputStream)
      } finally { $fs.Close(); $ctx.Response.OutputStream.Close() }
      return
    }
    '^/api/open-exports$' {
      Start-Process explorer.exe -ArgumentList (Quote-Arg $ExportDir)
      Send-Json $ctx 200 @{ ok = $true }
      return
    }
    default { Send-Json $ctx 404 @{ error = 'unknown endpoint' } }
  }
}

# ---- Main loop --------------------------------------------------------------------------------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("$Origin/")
$started = $false
for ($try = 0; $try -lt 12 -and -not $started; $try++) {
  try { $listener.Start(); $started = $true }
  catch { if ($Open) { break }; Start-Sleep -Milliseconds 500; $listener = New-Object System.Net.HttpListener; $listener.Prefixes.Add("$Origin/") }
}
if (-not $started) {
  Write-Host "Port $Port is busy - Frame is probably already running. Opening it." -ForegroundColor Yellow
  if ($Open) { Start-Process "$Origin/" }
  exit 0
}

Write-Host ''
Write-Host '  FRAME  video editor' -ForegroundColor Cyan
Write-Host "  Running at $Origin   (close this window to quit)"
Write-Host "  FFmpeg: $(if ($script:Ffmpeg) { $script:Ffmpeg } else { 'NOT FOUND - export will not work' })"
Write-Host "  NVIDIA key from .env: $(if ($script:EnvKey) { 'yes' } else { 'no (you can paste one in the app)' })"
Write-Host ''

if ($Open) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $browser = if ($chrome) { $chrome } else { $edge }
  if ($browser) { Start-Process $browser -ArgumentList "--app=$Origin/", '--start-maximized' } else { Start-Process "$Origin/" }
}

while ($listener.IsListening) {
  $async = $listener.BeginGetContext($null, $null)
  while (-not $async.AsyncWaitHandle.WaitOne(300)) { }
  $ctx = $listener.EndGetContext($async)
  try {
    $host_ = $ctx.Request.Headers['Host']
    if ($host_ -ne "localhost:$Port") { Send-Json $ctx 403 @{ error = 'bad host' } }
    elseif ($ctx.Request.Url.AbsolutePath.StartsWith('/api/')) { Handle-Api $ctx }
    else { Serve-Static $ctx }
  } catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    try { Send-Json $ctx 500 @{ error = $_.Exception.Message } } catch { }
  }
  if ($script:RestartCode -eq 42) { $listener.Stop(); exit 42 }
}
