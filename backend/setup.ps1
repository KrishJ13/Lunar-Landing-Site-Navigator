# Reproducible backend setup (Windows PowerShell). Run from anywhere.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) { python -m venv .venv }
& .\.venv\Scripts\python -m pip install -q -r requirements.txt
if ($LASTEXITCODE) { throw "pip install failed" }
& .\.venv\Scripts\python scripts\download_kernels.py
if ($LASTEXITCODE) { throw "kernel download/verification failed" }
& .\.venv\Scripts\python -m pytest -q tests
if ($LASTEXITCODE) { throw "tests failed" }
Write-Host "Backend setup OK"
