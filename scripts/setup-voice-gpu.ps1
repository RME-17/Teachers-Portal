# Recruit My English - GPU voice stack setup (two isolated envs; CUDA cu124 for GTX 10xx+)
# STT env (Parakeet/NeMo) and Voice env (Chatterbox TTS + Silero VAD) are kept separate because
# NeMo needs numpy 2 / transformers 4.x while Chatterbox needs numpy<2 / transformers 5.x.
# No admin required; everything installs under %APPDATA%\Recruit My English.

$ErrorActionPreference = "Stop"
Write-Host "== Recruit My English: GPU voice setup (cu124, dual-env) ==" -ForegroundColor Cyan

$py = "python"
try { & $py --version | Out-Null } catch { throw "Python not found on PATH. Install Python 3.11 from python.org (check 'Add to PATH') and re-run." }

$UserData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) "Recruit My English"
New-Item -ItemType Directory -Force -Path $UserData | Out-Null
$TORCH = "https://download.pytorch.org/whl/cu124"

function New-Venv($dir) {
  $vpy = Join-Path $dir "Scripts\python.exe"
  if (-not (Test-Path $vpy)) { Write-Host "Creating venv $dir ..."; & $py -m venv $dir }
  & $vpy -m pip install --upgrade pip wheel setuptools | Out-Null
  return $vpy
}

$SttDir = Join-Path $UserData "voice-venv"
$SttPy  = New-Venv $SttDir
Write-Host "Ensuring Parakeet (NeMo) packages in STT env ..." -ForegroundColor Cyan
& $SttPy -m pip install "nemo_toolkit[asr]>=2.0.0" "aiohttp>=3.9" "soundfile>=0.12" "pyarrow==21.0.0"
Write-Host "Installing CUDA PyTorch (cu124) into STT env ..." -ForegroundColor Cyan
& $SttPy -m pip install --upgrade --force-reinstall torch==2.6.0 torchaudio==2.6.0 --index-url $TORCH

$TtsDir = Join-Path $UserData "tts-venv"
$TtsPy  = New-Venv $TtsDir
Write-Host "Installing Chatterbox TTS + Silero VAD ..." -ForegroundColor Cyan
& $TtsPy -m pip install "chatterbox-tts>=0.1.7" "fastapi>=0.115.0" "uvicorn>=0.34.0" psutil nvidia-ml-py "silero-vad>=5.1" "websockets>=12.0"
Write-Host "Installing CUDA PyTorch (cu124) into Voice env ..." -ForegroundColor Cyan
& $TtsPy -m pip install --upgrade --force-reinstall torch==2.6.0 torchaudio==2.6.0 --index-url $TORCH

Write-Host "`n-- CUDA check --" -ForegroundColor Yellow
& $SttPy -c "import torch;print('STT   torch',torch.__version__,'CUDA',torch.cuda.is_available())"
& $TtsPy -c "import torch;print('Voice torch',torch.__version__,'CUDA',torch.cuda.is_available(),(torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''))"

$EnvFile = Join-Path $UserData ".env"
$lines = if (Test-Path $EnvFile) { @(Get-Content $EnvFile -Encoding UTF8) } else { @() }
function Set-EnvLine($k,$v){ $script:lines = @($script:lines | Where-Object { $_ -notmatch "^\s*$k=" }); $script:lines += "$k=$v" }
Set-EnvLine "RME_PARAKEET_PYTHON"      $SttPy
Set-EnvLine "RME_PYTHON_EXE"           $TtsPy
Set-EnvLine "RME_PARAKEET_DEVICE"      "cuda"
Set-EnvLine "RME_CHATTERBOX_POOL_SIZE" "1"
Set-Content -Path $EnvFile -Value $lines -Encoding UTF8

Write-Host "`nSetup complete." -ForegroundColor Green
Write-Host "Fully quit and reopen Recruit My English. First voice session downloads the models (several GB)."
