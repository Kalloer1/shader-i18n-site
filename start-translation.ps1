param([int]$Top = 125)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $env:LLM_MODELS) {
  $env:LLM_MODELS = 'muse-spark-1.3-contributor-free,muse-spark-1.2-contributor-free,mimo-v2.6-flash-free'
}
if (-not $env:LLM_CONCURRENCY) { $env:LLM_CONCURRENCY = '10' }

if (-not $env:LLM_API_KEY -and -not $env:SILICONFLOW_API_KEY) {
  $secure = Read-Host '请输入 LLM API Key（不会写入文件）' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:LLM_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $env:LLM_API_KEY -and -not $env:SILICONFLOW_API_KEY) { throw '没有提供 API Key' }
Write-Host "将使用 $env:LLM_MODELS，以 $env:LLM_CONCURRENCY 并发处理前 $Top 个候选。"
$confirm = Read-Host '输入 Y 开始，其他任意键取消'
if ($confirm -notmatch '^[Yy]$') { Write-Host '已取消。'; exit 0 }
& npm run translate -- --top $Top
exit $LASTEXITCODE

