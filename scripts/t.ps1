param([string]$file, [int]$timeout = 90, [int]$lines = 40)
$out = Join-Path $env:TEMP "flow-t-$([IO.Path]::GetFileName($file)).out"
$p = Start-Process -FilePath node -ArgumentList @('--test', '--test-timeout=30000', '--test-reporter=tap', "test/$file") -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
if (-not $p.WaitForExit($timeout * 1000)) { taskkill /T /F /PID $p.Id | Out-Null; "TIMEOUT after ${timeout}s" }
$t = Get-Content $out
($t | Select-String -Pattern '^# (pass|fail)').Line -join ' '
$t | Select-String -Pattern '^\s*not ok|^\s+(error|expected|actual):|message' | Select-Object -First $lines | ForEach-Object { $_.Line }

