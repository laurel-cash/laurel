# Android tools and caches live on D:. No machine-wide environment is changed.
# Tauri's arguments in $args, not a [Parameter] list: that made this an advanced script,
# whose own -Debug took --debug, and every "debug" build came out a release one
param(
	[ValidateSet('init', 'dev', 'build')][string]$Action = 'build'
)
$TauriArgs = [string[]]$args
if ($Action -eq 'init' -and (Test-Path -LiteralPath "$PSScriptRoot\..\src-tauri\gen\android\app\src\main\AndroidManifest.xml")) {
	throw 'Android project already exists. Use build or dev; regenerating it would replace wallet security settings.'
}
. "$PSScriptRoot\windows-env.ps1"
# below normal, and Tauri, cargo and Gradle with it (a process's priority is handed on):
# a build uses idle cpu, and the person's own work comes first
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch { }
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_USER_HOME = 'D:\Android\user'
$env:ANDROID_AVD_HOME = 'D:\Android\avd'
$env:GRADLE_USER_HOME = 'D:\Android\gradle'
$env:JAVA_HOME = 'D:\Android\java\jdk-21.0.12.1+1'
$env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk\29.0.14206865'
# Android's Rust in a target folder of its own: sharing src-tauri\target with the
# gate's builds, each invalidated the other's host build scripts and proc macros, and
# an "incremental" debug APK recompiled all 445 crates (353s), then the gate needed --cold. Apart, one changed
# line of ui is a 27s debug APK
$env:CARGO_TARGET_DIR = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri\target-android'
# The engine's library keeps its symbols (Cargo.toml's release strips them, for the computer's
# installers): Gradle strips it for phones and puts the symbols in the bundle (debugSymbolLevel),
# so a crash in Play's reports names the function
$env:CARGO_PROFILE_RELEASE_STRIP = 'false'
# Use the same verified roots as Windows on hosts with managed HTTPS inspection.
$env:JAVA_TOOL_OPTIONS = '-Djavax.net.ssl.trustStoreType=Windows-ROOT -Djavax.net.ssl.trustStore=NONE -Dsun.net.client.defaultReadTimeout=60000 -Djava.net.preferIPv4Stack=true -Djdk.tls.client.protocols=TLSv1.2 -Dhttps.protocols=TLSv1.2'
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
foreach ($tool in @("$env:JAVA_HOME\bin\java.exe", "$env:NDK_HOME\source.properties")) {
	if (-not (Test-Path -LiteralPath $tool)) { throw "Missing Android prerequisite: $tool. See docs/ANDROID.md." }
}
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
	# a Play bundle says what it was built from (scripts/play_bundle.mjs): the commit, whether
	# the tree held more than it, and the bundle's own hash, written once the build has
	# succeeded (Gradle leaves an up-to-date bundle as it was). Later commits that build
	# nothing into it (scripts, docs) then need no new build: a fat-LTO release takes 10 minutes
	$stamp = 'src-tauri\gen\android\app\build\outputs\bundle\built-from.txt'
	$playBundle = $Action -eq 'build' -and $TauriArgs -contains '--aab' -and $TauriArgs -notcontains '--debug'
	if ($playBundle) {
		Remove-Item -LiteralPath $stamp -ErrorAction SilentlyContinue
		$state = if (git status --porcelain --untracked-files=no) { 'dirty' } else { 'clean' }
		$builtFrom = "$(git rev-parse HEAD) $state"
	}
	# Tauri logs progress on stderr; under 5.1 with Stop, 2>&1 would throw on its first line.
	$ErrorActionPreference = 'Continue'
	& npm.cmd run tauri -- android $Action @TauriArgs 2>&1 | Tee-Object -Variable tauriOutput
	$tauriExit = $LASTEXITCODE
	if ($tauriExit -ne 0) {
		# The Rust build has finished when Tauri reaches its jniLibs symlink.
		# A regular copy lets Gradle package it without Windows Developer Mode.
		$symlinkDenied = ($tauriOutput -join "`n") -match 'Creation symbolic link is not allowed'
		$targetIndex = [Array]::IndexOf($TauriArgs, '--target')
		$target = if ($targetIndex -ge 0 -and $targetIndex + 1 -lt $TauriArgs.Length) { $TauriArgs[$targetIndex + 1] } else { '' }
		if ($Action -ne 'build' -or -not $symlinkDenied -or $target -notin @('aarch64', 'x86_64')) {
			throw "Android $Action failed with exit code $tauriExit. The Windows copy fallback requires build --target aarch64 or x86_64."
		}
		$debug = $TauriArgs -contains '--debug'
		$profile = if ($debug) { 'debug' } else { 'release' }
		$variant = if ($debug) { 'Debug' } else { 'Release' }
		$abi = if ($target -eq 'aarch64') { 'arm64-v8a' } else { 'x86_64' }
		$arch = if ($target -eq 'aarch64') { 'Arm64' } else { 'X86_64' }
		# --aab: the app bundle Google Play takes (bundle), else an APK (assemble)
		$task = if ($TauriArgs -contains '--aab') { 'bundle' } else { 'assemble' }
		$project = Join-Path (Get-Location) 'src-tauri\gen\android'
		$library = Join-Path $env:CARGO_TARGET_DIR "$target-linux-android\$profile\liblaurel_lib.so"
		$destination = Join-Path $project "app\src\main\jniLibs\$abi\liblaurel_lib.so"
		Copy-Item -LiteralPath $library -Destination $destination
		Write-Output 'Packaging the compiled Android library with a regular file copy.'
		& "$project\gradlew.bat" -p $project ":app:$task$arch$variant" -x ":app:rustBuild$arch$variant" --console=plain
		if ($LASTEXITCODE -ne 0) { throw "Android packaging failed with exit code $LASTEXITCODE." }
	}
	if ($playBundle) {
		# Tauri's own Gradle run names it universal; the copy fallback above, arm64
		$bundle = Get-ChildItem 'src-tauri\gen\android\app\build\outputs\bundle\universalRelease\*.aab', 'src-tauri\gen\android\app\build\outputs\bundle\arm64Release\*.aab' -ErrorAction SilentlyContinue |
			Sort-Object LastWriteTime -Descending | Select-Object -First 1
		$relative = (Resolve-Path -Relative $bundle.FullName) -replace '^\.\\', '' -replace '\\', '/'
		Set-Content -LiteralPath $stamp -Value "$builtFrom $((Get-FileHash $bundle.FullName -Algorithm SHA256).Hash) $relative" -Encoding ascii
	}
} finally { Pop-Location }
