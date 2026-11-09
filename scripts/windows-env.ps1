# Load the compiler environment in this shell only. Dot-source before npm commands.
# Stop applies to this script alone: dot-sourced, it would otherwise stay in the
# caller, and Windows PowerShell 5.1 turns a tool's first stderr line into a throw.
$callerErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
	$vswhere = 'D:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
}
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Visual Studio C++ build tools were not found.' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
# vcvars is an installed tool path; reject shell metacharacters before cmd reads it.
if ($vcvars -match '["&|<>^%!]') { throw 'Unsupported Visual Studio installation path.' }
$compilerStart = [System.Diagnostics.ProcessStartInfo]::new('cmd.exe')
$compilerStart.Arguments = '/d /s /c ""' + $vcvars + '" >nul && set"'
$compilerStart.UseShellExecute = $false
$compilerStart.CreateNoWindow = $true
$compilerStart.RedirectStandardOutput = $true
$compilerProcess = [System.Diagnostics.Process]::Start($compilerStart)
$compilerEnvironment = $compilerProcess.StandardOutput.ReadToEnd() -split "`r?`n"
$compilerProcess.WaitForExit()
if ($compilerProcess.ExitCode -ne 0) { throw 'Could not load the Visual Studio environment.' }
foreach ($line in $compilerEnvironment) {
	if ($line -match '^([^=]+)=(.*)$') { Set-Item -LiteralPath "Env:$($Matches[1])" -Value $Matches[2] }
}
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $env:VCToolsInstallDir 'bin\Hostx64\x64\link.exe'
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'http.sslBackend'
$env:GIT_CONFIG_VALUE_0 = 'schannel'
$ErrorActionPreference = $callerErrorAction
