@echo off
chcp 65001 >nul
echo ========================================
echo   个人学习平台 - 服务器启动
echo   地址: http://localhost:3000
echo ========================================
echo.
cd /d "%~dp0.."
node --experimental-sqlite server\server.js
pause
