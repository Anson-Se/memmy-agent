param([string]$HelperPath = (Join-Path $PSScriptRoot '../../../../src/tools/computer-history/win/app-icon.ps1'))

# Run the unchanged production helper with real local .lnk/.ico/.exe files and
# Shell icon extraction. Only process and Start Menu enumeration are isolated;
# no user shortcuts are changed and no fixture executable is started.
$ErrorActionPreference = 'Stop'
$HelperPath = (Resolve-Path -LiteralPath $HelperPath).Path
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('memmy-icon-shortcuts-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$shell = $null
$shortcut = $null
try {
  Add-Type -AssemblyName System.Drawing
  $color = [Drawing.Color]::FromArgb(255, 30, 210, 150)
  $bitmap = New-Object Drawing.Bitmap(64, 64)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $pngStream = New-Object IO.MemoryStream
  try {
    $graphics.Clear($color)
    $bitmap.Save($pngStream, [Drawing.Imaging.ImageFormat]::Png)
    $png = $pngStream.ToArray()
  } finally {
    $pngStream.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  }

  # A single 64x64 PNG image in an ICO container, with a distinctive solid color.
  # Pixel assertions below reject a generic icon or Update.exe's launcher icon.
  $icoPath = Join-Path $fixture 'MemmySameNameIco.ico'
  $writer = New-Object IO.BinaryWriter([IO.File]::Create($icoPath))
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]64); $writer.Write([byte]64); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
  } finally { $writer.Dispose() }

  $launcher = Join-Path $fixture 'Update.exe'
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $launcher
  $exePath = Join-Path $fixture 'MemmySameNameExe.EXE'
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Destination $exePath
  $cases = @(
    @{ name = 'MemmySameNameIco'; icon = $icoPath; customColor = $true },
    @{ name = 'MemmySameNameExe'; icon = $exePath; customColor = $false },
    @{ name = 'MemmyDifferentNameIco'; icon = $icoPath; customColor = $true }
  )
  $shell = New-Object -ComObject WScript.Shell
  foreach ($case in $cases) {
    $shortcut = $shell.CreateShortcut((Join-Path $fixture ($case.name + '.lnk')))
    $shortcut.TargetPath = $launcher
    $shortcut.Arguments = '--processStart ' + $case.name + '.exe'
    $shortcut.IconLocation = $case.icon + ',0'
    $shortcut.Save()
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    $shortcut = $null
  }

  function Get-Process { }
  function Get-ChildItem {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Filter, [switch]$File, [switch]$Recurse)
    Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $fixture -Filter '*.lnk' -File
  }
  $ids = @($cases | ForEach-Object { 'win32.' + $_.name.ToLowerInvariant() })
  $json = ConvertTo-Json -InputObject $ids -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $raw = & $HelperPath -IdsBase64 $encoded
  $icons = ($raw -join "`n") | ConvertFrom-Json
  foreach ($case in $cases) {
    $id = 'win32.' + $case.name.ToLowerInvariant()
    if (-not $icons.$id) { throw "Missing shortcut icon for $($case.name)" }
    $bytes = [Convert]::FromBase64String($icons.$id)
    $stream = New-Object IO.MemoryStream(,$bytes)
    $image = $null
    try {
      $image = [Drawing.Bitmap]::FromStream($stream)
      if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid -or
          $image.Width -ne 64 -or $image.Height -ne 64) { throw "Invalid PNG for $($case.name)" }
      if ($case.customColor -and $image.GetPixel(32, 32).ToArgb() -ne $color.ToArgb()) {
        throw "Shortcut lost its custom icon for $($case.name)"
      }
      if (-not $case.customColor -and $icons.$id -cne [MemmyWindowsHistoryIcon]::Png64($exePath)) {
        throw 'Executable icon resolution changed'
      }
    } finally {
      if ($null -ne $image) { $image.Dispose() }
      $stream.Dispose()
    }
  }
  ConvertTo-Json -InputObject @{ runtime = $PSVersionTable.PSVersion.ToString(); sameNameIco = $true;
    sameNameExe = $true; differentNameIco = $true; customIconPixels = $true } -Compress
} finally {
  if ($null -ne $shortcut) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
