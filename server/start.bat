@echo off
chcp 65001 >nul
echo ========================================
echo   Study Platform - 服务器启动
echo   地址: http://localhost:3000
echo ========================================
echo.
cd /d "%~dp0.."
node server\server.js
pause
