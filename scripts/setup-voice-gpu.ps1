# Recruit My English - GPU voice stack setup (Parakeet STT + Chatterbox TTS + Silero VAD)
# Creates a Python venv in %APPDATA%\Recruit My English\voice-venv, installs CUDA PyTorch + engines,
# and registers it with the installed app via its userData .env. No admin required.

$ErrorActionPreference = "Stop"
Write-Host "== Recruit My English: GPU voice setup ==" -ForegroundColor Cyan

$py = "python"
try { & $py --version | Out-Null } catch { throw "Python not found on PATH. Install Python 3.11 from python.org (check 'Add to PATH') and re-run." }

$UserData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) "Recruit My English"
$VenvDir  = Join-Path $UserData "voice-venv"
New-Item -ItemType Directory -Force -Path $UserData | Out-Null
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
if (-not (Test-Path $VenvPy)) {
  Write-Host "Creating venv at $VenvDir ..."
  & $py -m venv $VenvDir
}

& $VenvPy -m pip install --upgrade pip wheel setuptools

Write-Host "Installing Chatterbox TTS ..." -ForegroundColor Cyan
& $VenvPy -m pip install "chatterbox-tts>=0.1.7" "fastapi>=0.115.0" "uvicorn>=0.34.0" psutil nvidia-ml-py
Write-Host "Installing Silero VAD ..." -ForegroundColor Cyan
& $VenvPy -m pip install "silero-vad>=5.1" "websockets>=12.0"
Write-Host "Installing Parakeet (NVIDIA NeMo) - this one is large ..." -ForegroundColor Cyan
& $VenvPy -m pip install "nemo_toolkit[asr]>=2.0.0" "aiohttp>=3.9" "soundfile>=0.12" "pyarrow==21.0.0"

Write-Host "Installing CUDA PyTorch (cu121) ..." -ForegroundColor Cyan
& $VenvPy -m pip install --upgrade --force-reinstall torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu121

& $VenvPy -c "import torch; print('torch', torch.__version__, '| CUDA available:', torch.cuda.is_available(), '|', (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only'))"

$EnvFile = Join-Path $UserData ".env"
$lines = if (Test-Path $EnvFile) { @(Get-Content $EnvFile -Encoding UTF8) } else { @() }
function Set-EnvLine($k,$v){ $script:lines = @($script:lines | Where-Object { $_ -notmatch "^\s*$k=" }); $script:lines += "$k=$v" }
Set-EnvLine "RME_PYTHON_EXE"       $VenvPy
Set-EnvLine "RME_PARAKEET_PYTHON"  $VenvPy
Set-EnvLine "RME_PARAKEET_DEVICE"  "cuda"
Set-EnvLine "RME_CHATTERBOX_POOL_SIZE" "1"
Set-Content -Path $EnvFile -Value $lines -Encoding UTF8

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Now fully quit and reopen Recruit My English."
Write-Host "The FIRST voice session downloads the models (several GB) - give it a few minutes."
