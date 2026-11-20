<#
.SYNOPSIS
  Installs the narration engine for VierVideo: Python packages and the Kokoro-82M voice model.

.DESCRIPTION
  VierVideo works without this. Narration needs it. The script
    1. finds Python 3.10 to 3.12 (the py launcher or python on PATH),
    2. creates %LOCALAPPDATA%\vier-tts\venv and installs requirements.txt into it,
    3. downloads the Kokoro-82M model into %LOCALAPPDATA%\vier-tts\hf-cache (about 0.4 GB; needs internet once),
    4. synthesises a test sentence to prove the engine works.
  Afterwards VierVideo runs the engine offline.

  Run it from the tts folder of the program:
    powershell -ExecutionPolicy Bypass -File setup-narration.ps1
  Use -VerifyOnly to skip steps 1 to 3 and only run the test in step 4.
  Use -Python to name a specific python.exe.

.PARAMETER VerifyOnly
  Only checks the engine that is already installed.

.PARAMETER Python
  Path to the python.exe to create the environment with.
#>
param(
  [switch]$VerifyOnly,
  [string]$Python = ''
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Join-Path $env:LOCALAPPDATA 'vier-tts'
$venv = Join-Path $base 'venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$cache = Join-Path $base 'hf-cache'
$worker = Join-Path $here 'worker.py'
$requirements = Join-Path $here 'requirements.txt'
$repo = (Get-Content -Raw -Encoding UTF8 (Join-Path $here 'config.json') | ConvertFrom-Json).repo_id

function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

function Find-BasePython {
  if ($Python) {
    if (-not (Test-Path $Python)) { throw "No file at $Python." }
    return $Python
  }
  $attempts = @(
    @{ Exe = 'py'; Args = @('-3.12') },
    @{ Exe = 'py'; Args = @('-3.11') },
    @{ Exe = 'py'; Args = @('-3.10') },
    @{ Exe = 'python'; Args = @() }
  )
  foreach ($a in $attempts) {
    if (-not (Get-Command $a.Exe -ErrorAction SilentlyContinue)) { continue }
    $probe = & $a.Exe @($a.Args) -c "import sys; print(sys.executable); print((3,10) <= sys.version_info[:2] <= (3,12))"
    if ($LASTEXITCODE -eq 0 -and @($probe).Count -ge 2 -and @($probe)[1].Trim() -eq 'True') {
      return @($probe)[0].Trim()
    }
  }
  throw 'Python 3.10 to 3.12 was not found. Install it from python.org (tick "Add python.exe to PATH") and run this again.'
}

function Invoke-Native([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) stopped with exit code $LASTEXITCODE." }
}

if (-not $VerifyOnly) {
  Write-Step 'Python'
  $basePy = Find-BasePython
  Write-Host "Using $basePy"

  Write-Step "Python environment in $venv"
  if (-not (Test-Path $venvPy)) { Invoke-Native $basePy @('-m', 'venv', $venv) }
  Invoke-Native $venvPy @('-m', 'pip', 'install', '--upgrade', 'pip')
  Invoke-Native $venvPy @('-m', 'pip', 'install', '-r', $requirements)

  Write-Step "Voice model $repo (about 0.4 GB, once)"
  $env:HF_HOME = $cache
  $env:HF_HUB_OFFLINE = '0'
  try {
    Invoke-Native $venvPy @('-c', "from huggingface_hub import snapshot_download; print(snapshot_download('$repo'))")
  } finally {
    Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
  }
}

Write-Step 'Test: the engine synthesises a sentence offline'
if (-not (Test-Path $venvPy)) { throw "The narration environment is not installed ($venvPy). Run this script without -VerifyOnly." }
$out = Join-Path ([IO.Path]::GetTempPath()) ('vier-tts-check-' + [guid]::NewGuid().ToString('N') + '.wav')
$request = (@{ id = 1; op = 'synth'; text = 'Narration is ready.'; voice = 'af_heart'; speed = 1.0; out = $out } | ConvertTo-Json -Compress)
$reply = ($request | & $venvPy $worker | Select-Object -First 1)
if ($reply -notmatch '"ok": ?true') { throw "The engine did not synthesise the test sentence: $reply" }
if (-not (Test-Path $out)) { throw "The engine reported success but wrote no file: $out" }
Remove-Item $out -ErrorAction SilentlyContinue
Write-Host "Narration engine ready. Python environment: $venv" -ForegroundColor Green
