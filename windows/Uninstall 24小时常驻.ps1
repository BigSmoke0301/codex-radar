$ErrorActionPreference = 'SilentlyContinue'
$taskName = 'Codex Radar 24h'

Stop-ScheduledTask -TaskName $taskName
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like '*CodexRadar-Watchdog.ps1*'
} | Invoke-CimMethod -MethodName Terminate | Out-Null

Write-Host 'Codex Radar 24 小时常驻已关闭；程序文件与监控历史仍保留。'
