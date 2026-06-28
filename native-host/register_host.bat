@echo off
setlocal

:: ============================================================
::  Toxic Downloader - Non-interactive native host registration
::  Double-click to run. No typing required.
::
::  It (1) rewrites the native messaging manifest with the correct
::  absolute paths and the extension ID, then (2) registers it in
::  the Windows registry for Chrome - all without prompting.
::
::  Optional: pass your extension ID as the first argument to
::  override the default, e.g.:
::      register_host.bat abcdefghijklmnopabcdefghijklmnop
:: ============================================================

:: Default extension ID = the one already baked into the manifest.
set "DEFAULT_EXT_ID=gmjhfmlmjjoffnamfcgggnhmfbmgpblh"
set "EXT_ID=%~1"
if "%EXT_ID%"=="" set "EXT_ID=%DEFAULT_EXT_ID%"

:: Resolve paths relative to THIS script's folder (works wherever the
:: project lives, so it keeps working even if the folder is moved).
set "HOST_DIR=%~dp0"
set "HOST_BAT=%HOST_DIR%toxic_ffmpeg_host.bat"
set "MANIFEST_PATH=%HOST_DIR%com.toxicdownloader.ffmpeg.json"

echo === Toxic Downloader - native host registration ===
echo Extension ID : %EXT_ID%
echo Manifest     : %MANIFEST_PATH%
echo Host script  : %HOST_BAT%
echo.

:: --- Sanity checks (warn only, do not block) ---
python --version >nul 2>&1
if errorlevel 1 (
    echo [WARN] Python not found in PATH - the host will not run until Python is installed.
) else (
    echo [OK] Python found
)
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARN] FFmpeg not found in PATH - remux will fail until FFmpeg is installed.
) else (
    echo [OK] FFmpeg found
)
if not exist "%HOST_BAT%" echo [WARN] toxic_ffmpeg_host.bat not found next to this script!
echo.

:: --- Escape backslashes for the JSON path value ---
set "HOST_BAT_ESC=%HOST_BAT:\=\\%"

:: --- (Re)write the native messaging manifest ---
echo Writing manifest...
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

:: --- Register the manifest path in the registry (no prompt) ---
echo Registering with Chrome...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.toxicdownloader.ffmpeg" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
if errorlevel 1 (
    echo [ERROR] Registry update failed.
) else (
    echo [OK] Registry key set.
)

echo.
echo === Done. Restart Chrome, then choose "System FFmpeg" in Toxic Downloader settings. ===
echo If your extension ID is not %DEFAULT_EXT_ID%, re-run as:
echo     register_host.bat YOUR_EXTENSION_ID
echo.
pause
endlocal
