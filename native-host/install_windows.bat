@echo off
echo === Toxic Downloader - Native FFmpeg Host Installer ===
echo.

:: Get the directory of this script
set "HOST_DIR=%~dp0"
set "HOST_BAT=%HOST_DIR%toxic_ffmpeg_host.bat"
set "MANIFEST_PATH=%HOST_DIR%com.toxicdownloader.ffmpeg.json"

:: Check for Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH.
    echo Install Python from https://python.org
    pause
    exit /b 1
)
echo [OK] Python found

:: Check for FFmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARN] FFmpeg not found in PATH.
    echo Install FFmpeg from https://ffmpeg.org/download.html
    echo.
) else (
    echo [OK] FFmpeg found
)

:: Ask for extension ID
echo.
echo To find your extension ID:
echo   1. Go to chrome://extensions
echo   2. Find "Toxic Downloader"
echo   3. Copy the ID shown under the extension name
echo.
set /p EXT_ID="Enter your extension ID: "
if "%EXT_ID%"=="" (
    echo ERROR: Extension ID is required.
    echo Find it at chrome://extensions under Toxic Downloader.
    pause
    exit /b 1
)

:: Escape backslashes for JSON path
set "HOST_BAT_ESC=%HOST_BAT:\=\\%"

:: Create native messaging host manifest
echo.
echo Creating native messaging manifest...
(
echo {
echo   "name": "com.toxicdownloader.ffmpeg",
echo   "description": "Toxic Downloader FFmpeg Native Host",
echo   "path": "%HOST_BAT_ESC%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://%EXT_ID%/"
echo   ]
echo }
) > "%MANIFEST_PATH%"

:: Register in Windows Registry for Chrome
echo Registering native messaging host...
python -c "import winreg; key=winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Google\Chrome\NativeMessagingHosts\com.toxicdownloader.ffmpeg'); winreg.SetValueEx(key, '', 0, winreg.REG_SZ, r'%MANIFEST_PATH%'); winreg.CloseKey(key); print('[OK] Registry updated')"

echo.
echo === Installation complete! ===
echo Extension ID: %EXT_ID%
echo Native host: %HOST_BAT%
echo.
echo Restart Chrome, then select "System FFmpeg" in Toxic Downloader settings.
pause
