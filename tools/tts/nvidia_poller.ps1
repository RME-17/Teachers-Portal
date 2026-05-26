Remove-Item -Force nvidia_log.csv -ErrorAction SilentlyContinue
while ($true) {
    $line = (Get-Date).ToString('o') + ' ' + (nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits)
    $line | Out-File -FilePath nvidia_log.csv -Append
    Start-Sleep -Milliseconds 200
}
