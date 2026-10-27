@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ===== Python 解释器探测 =====
rem 若自动探测失败，取消下面这行的注释并把路径改成你的 python.exe
rem set "PY=你的 python.exe 完整路径"

set "PY="
if not defined PY call :detect "py -3"
if not defined PY call :detect "python"
if not defined PY call :detect "python3"

if not defined PY (
    echo [错误] 未检测到可用的 Python。
    echo.
    echo 请二选一：
    echo   1. 安装 Python 3.11+ 并勾选 Add Python to PATH，然后重新双击本脚本
    echo   2. 记事本打开本脚本，取消上面第 8 行的注释并改成你的 python.exe 路径
    echo.
    pause
    exit /b 1
)
goto :main

rem 实际执行一次来确认可用，避开 Microsoft Store 的 python 假存根
:detect
%~1 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=%~1"
goto :eof

:main
set "URL=http://127.0.0.1:8765/"

echo ==========================================
echo   世界杯知识库 · 本地启动
echo ==========================================
echo.

rem 服务已在运行 → 直接开浏览器，不重复占用端口
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest '%URL%api/health' -TimeoutSec 2 -UseBasicParsing; exit 0 }catch{ exit 1 }"
if %errorlevel%==0 (
    echo 服务已在运行，正在打开浏览器...
    start "" %URL%
    exit /b 0
)

echo 正在启动服务端（首次约 20 秒：加载 torch 权重 + 重排模型）...
start "" /B "%PY%" -X utf8 server.py

powershell -NoProfile -Command "for($i=1;$i -le 60;$i++){ Start-Sleep -Seconds 2; try{ $r=Invoke-WebRequest '%URL%api/health' -TimeoutSec 2 -UseBasicParsing; if($r.StatusCode -eq 200){ Write-Output ('服务就绪（等待 ' + ($i*2) + ' 秒）'); exit 0 } }catch{} }; Write-Output '启动超时'; exit 1"

if %errorlevel%==0 (
    echo 正在打开浏览器...
    start "" %URL%
    echo.
    echo 服务已在后台运行。关闭本窗口不会停止服务；
    echo 要停止服务，请结束 python.exe 进程。
) else (
    echo.
    echo 启动失败。可手动执行下面这行看报错：
    echo   "%PY%" -X utf8 server.py
)

echo.
pause
