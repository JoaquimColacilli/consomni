# Pre-extrae winCodeSign-2.6.0 SIN los 2 symlinks darwin (.dylib) que requieren
# privilegio de Developer Mode/admin. En Windows sólo se usa windows-10\, así que
# excluir darwin\ permite que rcedit (embebido de icono) corra sin firmar.
# Idempotente: si ya está extraído, no hace nada.
$ErrorActionPreference = "Stop"
$cache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$dest = Join-Path $cache "winCodeSign-2.6.0"

if (Test-Path (Join-Path $dest "windows-10")) {
  Write-Output "winCodeSign ya preparado: $dest"
  exit 0
}

$src7z = $null
if (Test-Path $cache) {
  $src7z = Get-ChildItem (Join-Path $cache "*.7z") -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $src7z) {
  Write-Output "No hay winCodeSign .7z en cache; electron-builder lo descargará. Re-corré este script tras el primer intento."
  exit 0
}

$7z = Join-Path $PSScriptRoot "..\node_modules\7zip-bin\win\x64\7za.exe"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
# -xr!darwin excluye la carpeta darwin (única con symlinks) → extracción limpia
& $7z x $src7z.FullName "-o$dest" "-xr!darwin" -y | Out-Null
if (Test-Path (Join-Path $dest "windows-10")) {
  Write-Output ("OK winCodeSign preparado (sin darwin): {0}" -f $dest)
} else {
  Write-Output "ADVERTENCIA: no se encontró windows-10\ tras extraer; revisar."
}
