$ErrorActionPreference = 'Stop'
$taskName = 'Codex Radar 24h'
$radarDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$radarExe = Join-Path $radarDir 'CodexRadar.exe'
$watchdog = Join-Path $radarDir 'CodexRadar-Watchdog.ps1'

if (-not (Test-Path -LiteralPath $radarExe) -or -not (Test-Path -LiteralPath $watchdog)) {
    throw '请完整解压 Windows 安装包后，从 CodexRadar.exe 同一目录运行此脚本。'
}

$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$actionArgs = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArgs -WorkingDirectory $radarDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host 'Codex Radar 24 小时常驻已启用：登录后自动启动、异常退出后自动重启、提醒持续 60 秒。'
Write-Host '关机、注销或系统真正进入睡眠时，软件无法继续监控。'
