@echo off
setlocal
set "PSModulePath="
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0installer\Install.ps1"
exit /b
