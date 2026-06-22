PowerShell输入
Start-Process msedge -ArgumentList "--remote-debugging-port=9222","--no-first-run"

然后检查端口是否正常
Test-NetConnection -ComputerName localhost -Port 9222 -InformationLevel Quiet

True 就说明可以连接

更稳的是先把 Edge 全部关掉Stop-Process -Name msedge