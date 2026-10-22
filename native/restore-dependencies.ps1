param([string]$LibraryDirectory = (Join-Path $PSScriptRoot 'lib'))
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dependencies.lock.json') -Raw | ConvertFrom-Json
$officialUrl = 'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg'
if ($lock.packageId -ne 'Newtonsoft.Json' -or $lock.version -ne '13.0.3' -or $lock.url -cne $officialUrl -or $lock.assemblyEntry -cne 'lib/net45/Newtonsoft.Json.dll') {
    throw 'Unsupported dependency lock. Only the pinned Newtonsoft.Json 13.0.3 official NuGet package is accepted.'
}
foreach ($value in @($lock.packageSha256, $lock.assemblySha256)) {
    if ($value -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid SHA256 in dependency lock.' }
}
function Assert-Hash([string]$File, [string]$Expected) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
    if ($actual -ne $Expected) { throw "Dependency integrity check failed: $File. Remove this cached file and restore it again." }
}
$LibraryDirectory = [IO.Path]::GetFullPath($LibraryDirectory)
[void][IO.Directory]::CreateDirectory($LibraryDirectory)
$assembly = Join-Path $LibraryDirectory 'Newtonsoft.Json.dll'
if (Test-Path -LiteralPath $assembly) {
    # Always check the assembly, including offline builds with a populated cache.
    Assert-Hash $assembly $lock.assemblySha256
    Write-Output $assembly
    return
}
$cache = Join-Path $LibraryDirectory 'packages'
[void][IO.Directory]::CreateDirectory($cache)
$package = Join-Path $cache 'newtonsoft.json.13.0.3.nupkg'
$temporaryPackage = $null
$temporaryAssembly = $null
try {
    if (-not (Test-Path -LiteralPath $package)) {
        $temporaryPackage = Join-Path $cache ([Guid]::NewGuid().ToString('N') + '.download')
        # Use the official TLS endpoint and verify the downloaded package before extraction.
        $previousTls = [Net.ServicePointManager]::SecurityProtocol
        $client = New-Object Net.WebClient
        try {
            [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
            $client.DownloadFile($officialUrl, $temporaryPackage)
        } finally {
            $client.Dispose()
            [Net.ServicePointManager]::SecurityProtocol = $previousTls
        }
        Assert-Hash $temporaryPackage $lock.packageSha256
        Move-Item -LiteralPath $temporaryPackage -Destination $package
        $temporaryPackage = $null
    }
    Assert-Hash $package $lock.packageSha256
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        $entry = $archive.GetEntry($lock.assemblyEntry)
        $license = $archive.GetEntry($lock.licenseEntry)
        if ($null -eq $entry -or $null -eq $license) { throw 'Pinned NuGet package is missing the expected assembly or license.' }
        # Extract only these exact entries; never expand arbitrary package paths.
        $temporaryAssembly = Join-Path $LibraryDirectory ([Guid]::NewGuid().ToString('N') + '.dll.download')
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $temporaryAssembly, $false)
        Assert-Hash $temporaryAssembly $lock.assemblySha256
        [IO.Compression.ZipFileExtensions]::ExtractToFile($license, (Join-Path $LibraryDirectory 'Newtonsoft.Json.LICENSE.md'), $true)
        Move-Item -LiteralPath $temporaryAssembly -Destination $assembly
        $temporaryAssembly = $null
    } finally { $archive.Dispose() }
    Write-Output $assembly
} finally {
    foreach ($temporary in @($temporaryAssembly, $temporaryPackage)) {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    }
}
