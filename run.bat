@echo off
setlocal
cd /d "%~dp0"

REM Verify Python is installed
where py >nul 2>nul
if errorlevel 1 (
    echo Python is required. Install from https://www.python.org/downloads/ then re-run.
    pause
    exit /b 1
)

REM Verify ffmpeg is installed
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo.
    echo ffmpeg was not found on your PATH.
    echo Install it with:    winget install Gyan.FFmpeg
    echo Or download from:   https://www.gyan.dev/ffmpeg/builds/
    echo.
    pause
    exit /b 1
)

REM Create venv on first run
if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    py -3 -m venv .venv
    if errorlevel 1 (
        echo Failed to create venv.
        pause
        exit /b 1
    )
    echo Installing dependencies...
    .venv\Scripts\python.exe -m pip install --disable-pip-version-check -q -r requirements.txt
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

echo.
echo Clip Organizer is starting at http://127.0.0.1:8765
echo Press Ctrl+C in this window to stop it.
echo.
start "" http://127.0.0.1:8765
.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8765 --log-level warning
