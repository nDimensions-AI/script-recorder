param([string]$Executable)
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$version=(Get-Content -LiteralPath (Join-Path $workspace 'package.json') | ConvertFrom-Json).version
if(-not $Executable){$Executable=Join-Path $workspace ('release/nDimensions.AI Script Recorder-'+$version+'-windows-x64.exe')}
$testProfile=Join-Path $env:TEMP ('webinar-portable-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testProfile | Out-Null
$priorProfile=$env:WEBINAR_DATA_DIR
try {
  $env:WEBINAR_DATA_DIR=$testProfile
  $launcher=Start-Process -FilePath $Executable -ArgumentList '--remote-debugging-port=0' -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(240)
  while(-not (Test-Path -LiteralPath (Join-Path $testProfile 'DevToolsActivePort'))){
    if([DateTime]::UtcNow -gt $deadline){throw 'Portable launch timed out before opening its test connection.'}
    Start-Sleep -Milliseconds 500
  }
  $child=Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq $launcher.Id -and $_.Name -eq 'nDimensions.AI Script Recorder.exe'} | Select-Object -First 1
  if(-not $child){throw 'Could not identify the portable application process.'}
  $extracted=Split-Path -Parent $child.ExecutablePath
  Push-Location $workspace
  try {node scripts/webinar-portable-smoke.mjs $testProfile $extracted;if($LASTEXITCODE -ne 0){throw 'Portable smoke assertions failed.'}}finally{Pop-Location}
} finally {$env:WEBINAR_DATA_DIR=$priorProfile}
