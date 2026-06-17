@echo off
REM ─── Pulse Batcave — Windows Launcher ────────────────────────────────────────
REM Usage: Double-click START-PULSE.bat, or run from Command Prompt
REM Requirements: Node.js 18+ (https://nodejs.org)

title Pulse Batcave

echo.
echo   ╔══════════════════════════════════════╗
echo   ║      PULSE BATCAVE — LOCAL MODE      ║
echo   ╚══════════════════════════════════════╝
echo.

REM Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [error] Node.js not found. Install from https://nodejs.org (v18+ required).
    pause
    exit /b 1
)

REM Check .env.local
if not exist ".env.local" (
    echo [setup] .env.local not found.
    echo.
    echo   1. Open .env.local.template in Notepad
    echo   2. Copy it to .env.local
    echo   3. Fill in your Schwab Client ID and Secret
    echo   4. Save and re-run this script
    echo.
    echo   Your Schwab credentials are at: developer.schwab.com
    echo   - App Key  = SCHWAB_CLIENT_ID
    echo   - App Secret = SCHWAB_CLIENT_SECRET
    echo.
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules\" (
    echo [setup] Installing dependencies (this takes ~1 min on first run)...
    call npm install --no-audit --no-fund
    if %ERRORLEVEL% NEQ 0 (
        echo [error] npm install failed. Check your Node.js installation.
        pause
        exit /b 1
    )
    echo [setup] Dependencies installed.
)

REM Build if dist is missing
if not exist "dist\index.cjs" (
    echo [setup] Building app...
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo [error] Build failed. Check the output above.
        pause
        exit /b 1
    )
    echo [setup] Build complete.
)

REM Load .env.local environment variables
for /f "usebackq tokens=1,* delims==" %%A in (".env.local") do (
    if not "%%A"=="" (
        echo %%A | findstr /r "^[^#]" >nul 2>&1
        if not errorlevel 1 (
            set "%%A=%%B"
        )
    )
)

echo.
echo [start] Opening http://localhost:5000 in your browser in 3 seconds...
echo [start] Press Ctrl+C in this window to stop the server.
echo.

REM Open browser after short delay
start "" cmd /c "timeout /t 3 >nul && start http://localhost:5000"

REM Start server
node dist\index.cjs

pause
