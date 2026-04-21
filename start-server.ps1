# MagicBody GeoTracker 로컬 서버 시작
# PowerShell에서 실행: .\start-server.ps1

$envFile = Join-Path $PSScriptRoot ".env.local"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
    Write-Host "✅ .env.local 로드 완료" -ForegroundColor Green
} else {
    Write-Host "❌ .env.local 파일이 없습니다" -ForegroundColor Red
    exit 1
}

Write-Host "🚀 서버 시작 중... http://localhost:8040/geo-tracker" -ForegroundColor Cyan
node "$PSScriptRoot\.next\standalone\server.js" -p 8040
