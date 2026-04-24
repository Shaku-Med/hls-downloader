# Regenerate icon-16/32/48/128.png from icon.png (requires ffmpeg on PATH)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$src = Join-Path $dir 'icon.png'
if (-not (Test-Path -LiteralPath $src)) {
  Write-Error "Missing $src — place the master image there, then re-run."
}
foreach ($s in 16, 32, 48, 128) {
  $out = Join-Path $dir "icon-$s.png"
  & ffmpeg -y -hide_banner -loglevel error -i $src -vf "scale=${s}:${s}:flags=lanczos" -frames:v 1 $out
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "OK $out"
}
