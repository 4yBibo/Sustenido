# Packages the Release build (bin\out) as an MSIX for the Microsoft Store.
#   powershell -ExecutionPolicy Bypass -File tools\make-msix.ps1 -IdentityName <Partner Center name> -Publisher "CN=<GUID>" -PublisherDisplayName minibibo
# Without parameters it builds a local-test package. The Store signs submissions itself, so no certificate is needed
# for upload; a local sideload would need signtool + a trusted certificate, which this script does not set up.
param(
    [string]$IdentityName = 'minibibo.Sustenido',
    [string]$Publisher = 'CN=minibibo',
    [string]$PublisherDisplayName = 'minibibo',
    [string]$Version = '1.0.0.0',
    [string]$Out = 'bin\Sustenido.msix'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$build = Join-Path $root 'bin\out'
if (-not (Test-Path (Join-Path $build 'Sustenido.exe'))) { throw 'Compile primeiro: dotnet build Sustenido.csproj -c Release -o bin\out' }

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory | Where-Object { Test-Path "$($_.FullName)\x64\makeappx.exe" } | Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK (makeappx.exe) não encontrado.' }
$makeappx = "$($sdk.FullName)\x64\makeappx.exe"
$makepri = "$($sdk.FullName)\x64\makepri.exe"

$stage = Join-Path $root 'bin\msix-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\Assets" | Out-Null
Copy-Item "$build\*" $stage -Recurse -Force
Get-ChildItem $stage -Recurse -Include '*.pdb', '*.xml' -File | Where-Object { $_.Name -ne 'AppxManifest.xml' } | Remove-Item -Force

# Logos from the app icon (transparent squircle), at every size the manifest references.
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'web\icons\roxo.png'))
function Logo([string]$name, [int]$w, [int]$h, [double]$fill = 1.0) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
    $side = [int]([Math]::Min($w, $h) * $fill)
    $g.DrawImage($icon, [int](($w - $side) / 2), [int](($h - $side) / 2), $side, $side)
    $g.Dispose()
    $bmp.Save("$stage\Assets\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
Logo 'Square44x44Logo' 44 44
Logo 'Square44x44Logo.targetsize-44_altform-unplated' 44 44
Logo 'Square44x44Logo.targetsize-256_altform-unplated' 256 256
Logo 'Square150x150Logo' 150 150 0.66
Logo 'SmallTile' 71 71 0.66
Logo 'LargeTile' 310 310 0.66
Logo 'Wide310x150Logo' 310 150 0.66
Logo 'StoreLogo' 50 50
Logo 'FileLogo' 64 64
$icon.Dispose()

$manifest = Get-Content (Join-Path $root 'store\AppxManifest.xml') -Raw -Encoding UTF8
$manifest = $manifest.Replace('{IDENTITY_NAME}', $IdentityName).Replace('{PUBLISHER}', $Publisher).Replace('{PUBLISHER_DISPLAY_NAME}', $PublisherDisplayName).Replace('{VERSION}', $Version)
[System.IO.File]::WriteAllText("$stage\AppxManifest.xml", $manifest, (New-Object System.Text.UTF8Encoding $false))

# Resource index so Windows finds the scaled/unplated logo variants.
Push-Location $stage
try {
    & $makepri new /pr $stage /cf (Join-Path $root 'store\priconfig.xml') /of "$stage\resources.pri" /o | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'makepri falhou.' }
} finally { Pop-Location }

$outPath = Join-Path $root $Out
if (Test-Path $outPath) { Remove-Item $outPath -Force }
& $makeappx pack /d $stage /p $outPath /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'makeappx falhou.' }
Write-Host "Pacote gerado: $outPath ($([math]::Round((Get-Item $outPath).Length / 1MB, 1)) MB)"
