@echo off
setlocal
title Frame
cd /d "%~dp0"

where ffmpeg >nul 2>nul
if errorlevel 1 (
  if not exist "%~dp0tools\ffmpeg.exe" (
    echo.
    echo  FFmpeg was not found. Frame needs it to export MP4 videos.
    choice /c YN /m " Install FFmpeg now with winget"
    if not errorlevel 2 (
      winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
      echo.
      echo  FFmpeg installed. Please close this window and run start.bat again.
      pause
      exit /b 0
    )
  )
)

set FRAME_OPEN=-Open
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\server.ps1" -Port 4719 %FRAME_OPEN%
rem Exit code 42 = Frame installed an update and wants to restart.
if %errorlevel%==42 (
  set FRAME_OPEN=
  goto run
)
if errorlevel 1 pause
