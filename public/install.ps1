# MCLC Installer Script for Windows
# Run with: iwr https://mclc.pluginhub.de/install.ps1 | iex

$repo = "Lux-Client/LuxClient"
$baseUrl = "https://github.com/$repo/releases/latest/download"
$filename = "Lux-setup.exe"
$url = "$baseUrl/$filename"
$tempPath = [System.IO.Path]::GetTempFileName() + ".exe"

Write-Host "--- Lux Installer ---" -ForegroundColor Cyan
Write-Host "Downloading Lux from $url..."

try {
    Invoke-WebRequest -Uri $url -OutFile $tempPath -ErrorAction Stop
    Write-Host "Download successful." -ForegroundColor Green
    
    Write-Host "Starting installer..." -ForegroundColor Yellow
    Start-Process -FilePath $tempPath -Wait
    
    Write-Host "Installation completed or installer closed." -ForegroundColor Green
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if (Test-Path $tempPath) {
        Remove-Item $tempPath -Force
    }
}

Write-Host "----------------------"
