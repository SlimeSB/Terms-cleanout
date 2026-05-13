@echo off
rem chcp 65001 >nul
title 术语清洗系统

echo ========================================
echo   Minecraft 原版术语清洗系统
echo   正在启动...
echo ========================================

:: 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请安装 Python 3.12+
    pause
    exit /b 1
)

:: 安装后端依赖
echo [1/3] 安装后端依赖...
cd /d "%~dp0backend"
pip install -r requirements.txt -q

:: 启动后端 (后台)
echo [2/3] 启动后端服务 (端口 8001)...
start "术语清洗-后端" /min cmd /c "python main.py"

:: 安装前端依赖
echo [3/3] 安装前端依赖...
cd /d "%~dp0frontend"
if not exist "node_modules" npm install --silent

:: 启动前端
echo 启动前端服务...
start "术语清洗-前端" cmd /c "npm run dev"

:: 等待前端启动
timeout /t 3 /nobreak >nul

:: 打开浏览器
start http://localhost:5173

echo.
echo 后端: http://localhost:8001
echo 前端: http://localhost:5173
echo.
echo 关闭窗口即可停止服务。
echo ========================================
pause
