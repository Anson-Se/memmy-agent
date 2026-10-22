param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Plan)) | ConvertFrom-Json
  # Compilation runs at Host privilege: never use a plugin-writable TEMP.
  $compilerRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Memmy/SandboxCompiler'
  [IO.Directory]::CreateDirectory($compilerRoot) | Out-Null
  if (([IO.File]::GetAttributes($compilerRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe compiler directory' }
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($compilerRoot, $acl)
  $env:TEMP = $compilerRoot
  $env:TMP = $compilerRoot
  # Compile only Host-packaged source, never source supplied by a plugin.
  Add-Type -Path (Join-Path $PSScriptRoot 'Sandbox.cs')
  $childEnvironment = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MEMMY_SANDBOX_CHILD_ENV)) | ConvertFrom-Json
  $dictionary = New-Object 'System.Collections.Generic.Dictionary[string,string]'
  foreach ($property in $childEnvironment.PSObject.Properties) { $dictionary.Add($property.Name, [string]$property.Value) }
  $result = [Memmy.PluginSandbox]::Run(
    [string]$request.profile, [string]$request.command, [string[]]$request.args,
    [string]$request.cwd, [string[]]$request.readRoots, [string[]]$request.writeRoots, $dictionary)
  exit $result
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 125
}
