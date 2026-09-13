$ErrorActionPreference = 'Continue'
$radarDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$radarExe = Join-Path $radarDir 'CodexRadar.exe'

while ($true) {
    if (Test-Path -LiteralPath $radarExe) {
        try {
            $process = Start-Process -FilePath $radarExe `
                -ArgumentList @('--no-open', '--alarm-seconds', '60') `
                -WorkingDirectory $radarDir `
                -WindowStyle Hidden `
                -PassThru
            $process.WaitForExit()
        } catch {
            # Task Scheduler keeps this watchdog alive; retry after a short
            # delay if antivirus scanning or an update temporarily locks it.
        }
    }
    Start-Sleep -Seconds 10
}
