param([int]$Top = 1)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:SILICONFLOW_API_KEY) {
  $secure = Read-Host '请输入 SiliconFlow API Key（不会写入文件）' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:SILICONFLOW_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $env:SILICONFLOW_API_KEY) { throw '没有提供 API Key' }
Write-Host "将使用 tencent/Hunyuan-MT-7B 处理前 $Top 个候选。"
$confirm = Read-Host '输入 Y 开始，其他任意键取消'
if ($confirm -notmatch '^[Yy]$') { Write-Host '已取消。'; exit 0 }
& npm run translate -- --top $Top
exit $LASTEXITCODE

