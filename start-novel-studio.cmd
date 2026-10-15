@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "SERVICE_MODE="
if /i "%~1"=="--service" set "SERVICE_MODE=1"
rem The browser and documentation use this fixed local address. Do not inherit a
rem machine-wide PORT/HOST value, otherwise the service and opened page diverge.
set "PORT=3000"
set "HOST=127.0.0.1"
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Node.js 24 or newer is required. Install Node.js and run this file again.
    pause
    exit /b 1
  )
)

if not defined OPENAI_API_KEY (
  for /f "tokens=3" %%A in ('reg query HKCU\Environment /v OPENAI_API_KEY 2^>nul ^| findstr /i OPENAI_API_KEY') do set "OPENAI_API_KEY=%%A"
)
if not defined OPENAI_MODEL (
  for /f "tokens=3" %%A in ('reg query HKCU\Environment /v OPENAI_MODEL 2^>nul ^| findstr /i OPENAI_MODEL') do set "OPENAI_MODEL=%%A"
)
if not defined OPENAI_MODEL set "OPENAI_MODEL=gpt-6-astra"

set "NODE_PROXY_ARG="
if not defined HTTPS_PROXY (
  for /f "tokens=3" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable 2^>nul ^| findstr /i ProxyEnable') do set "PROXY_ENABLED=%%A"
  for /f "tokens=3" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i ProxyServer') do set "PROXY_SERVER=%%A"
  if /i "!PROXY_ENABLED!"=="0x1" if defined PROXY_SERVER (
    echo !PROXY_SERVER! | findstr /r /i "^https*://" >nul
    if errorlevel 1 (set "HTTPS_PROXY=http://!PROXY_SERVER!") else set "HTTPS_PROXY=!PROXY_SERVER!"
  )
)
rem Some local proxy clients keep their HTTP port active while the Windows
rem system-proxy switch is off. Detect this project's known local port without
rem changing the user's global proxy settings.
if not defined HTTPS_PROXY (
  netstat -ano | findstr "127.0.0.1:7897" | findstr "LISTENING" >nul
  if not errorlevel 1 set "HTTPS_PROXY=http://127.0.0.1:7897"
)
if defined HTTPS_PROXY (
  "!NODE_EXE!" --help | findstr /c:"--use-env-proxy" >nul
  if errorlevel 1 (
    echo The configured Windows proxy requires Node.js 24 or newer.
    pause
    exit /b 1
  )
  set "NODE_PROXY_ARG=--use-env-proxy"
  if not defined NO_PROXY set "NO_PROXY=127.0.0.1,localhost"
)

if defined SERVICE_MODE (
  "!NODE_EXE!" !NODE_PROXY_ARG! service-runner.mjs
  exit /b !errorlevel!
)

start "Novel Studio" /min "!NODE_EXE!" !NODE_PROXY_ARG! service-runner.mjs
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3000"
endlocal
