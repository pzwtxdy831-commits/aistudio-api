@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AIS 反代
node src\main.js
pause
