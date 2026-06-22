# Start the Hayba visual sidecar on :7821
# SAM weights are looked up under $env:HAYBA_SAM_CACHE (default ~/.cache/hayba-sam).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
python -m uvicorn app:app --host 127.0.0.1 --port 7821
