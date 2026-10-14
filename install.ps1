# Installs Sustenido for the current user (no admin) and registers it as a handler for .md/.markdown.
# Windows protects the final "default app" choice with a hash only the user can set, so this script
# registers Sustenido and then opens the Settings page where that one click happens.
#   powershell -ExecutionPolicy Bypass -File install.ps1             # install / update
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall  # remove everything
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'Programs\Sustenido'
$exe = Join-Path $dest 'Sustenido.exe'
$progId = 'Sustenido.md'
$exts = '.md', '.markdown'
$hkcu = [Microsoft.Win32.Registry]::CurrentUser

# CreateSubKey opens existing keys untouched — unlike New-Item -Force, which would wipe them.
function Set-Reg([string]$key, [string]$name, [string]$value) {
    $k = $hkcu.CreateSubKey($key)
    try { $k.SetValue($name, $value) } finally { $k.Close() }
}

Add-Type -Namespace Sustenido -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'
$notifyShell = { [Sustenido.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }

Get-Process Sustenido -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object {
    throw "Feche o Sustenido antes de continuar (PID $($_.Id))."
}

if ($Uninstall) {
    foreach ($key in "Software\Classes\$progId", 'Software\Classes\Applications\Sustenido.exe', 'Software\Sustenido') {
        $hkcu.DeleteSubKeyTree($key, $false)
    }
    foreach ($ext in $exts) {
        $k = $hkcu.OpenSubKey("Software\Classes\$ext\OpenWithProgids", $true)
        if ($k) { $k.DeleteValue($progId, $false); $k.Close() }
    }
    $k = $hkcu.OpenSubKey('Software\RegisteredApplications', $true)
    if ($k) { $k.DeleteValue('Sustenido', $false); $k.Close() }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    & $notifyShell
    Write-Host 'Sustenido removido.'
    return
}

# Build (the csproj bundles the web UI first) and install.
$out = Join-Path $PSScriptRoot 'bin\out'
dotnet build (Join-Path $PSScriptRoot 'Sustenido.csproj') -c Release -o $out --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw 'Falha no build.' }
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $out '*') $dest -Recurse -Force

# File type
$open = "`"$exe`" `"%1`""
Set-Reg "Software\Classes\$progId" '' 'Documento Markdown'
Set-Reg "Software\Classes\$progId\DefaultIcon" '' "`"$exe`",0"
Set-Reg "Software\Classes\$progId\shell\open\command" '' $open
foreach ($ext in $exts) { Set-Reg "Software\Classes\$ext\OpenWithProgids" $progId '' }

# "Open with" entry
Set-Reg 'Software\Classes\Applications\Sustenido.exe' 'FriendlyAppName' 'Sustenido'
Set-Reg 'Software\Classes\Applications\Sustenido.exe\shell\open\command' '' $open
foreach ($ext in $exts) { Set-Reg 'Software\Classes\Applications\Sustenido.exe\SupportedTypes' $ext '' }

# Default Apps registration
Set-Reg 'Software\Sustenido\Capabilities' 'ApplicationName' 'Sustenido'
Set-Reg 'Software\Sustenido\Capabilities' 'ApplicationDescription' 'Leitor e editor de Markdown'
foreach ($ext in $exts) { Set-Reg 'Software\Sustenido\Capabilities\FileAssociations' $ext $progId }
Set-Reg 'Software\RegisteredApplications' 'Sustenido' 'Software\Sustenido\Capabilities'

& $notifyShell
Write-Host "Sustenido instalado em $dest"
Write-Host 'Abrindo Configurações: clique em "Definir padrão" para o Sustenido.'
Start-Process 'ms-settings:defaultapps?registeredAppUser=Sustenido'
