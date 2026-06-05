[CmdletBinding()]
param(
    [int]$Port = 5173,
    [string]$Output = ""
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $root "dist"
if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path $root "artifacts\ui-review.png"
}

if (-not (Test-Path -LiteralPath (Join-Path $dist "index.html"))) {
    throw "dist/index.html not found. Run npm run build first."
}

$browserCandidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

$browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($browser)) {
    throw "No Edge or Chrome executable found."
}

$pythonCommand = ""
$pythonArgs = @()
foreach ($candidate in @(
        @{ Command = "python"; Args = @() },
        @{ Command = "py"; Args = @("-3") }
    )) {
    try {
        & $candidate.Command @($candidate.Args) --version *> $null
        if ($LASTEXITCODE -eq 0) {
            $pythonCommand = $candidate.Command
            $pythonArgs = @($candidate.Args)
            break
        }
    } catch {
        continue
    }
}

if ([string]::IsNullOrWhiteSpace($pythonCommand)) {
    throw "No usable Python executable found."
}

$outputDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$existing = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    throw "Port $Port is already in use."
}

$job = Start-Job -ScriptBlock {
    param($PythonCommand, $PythonArgs, $ServeDir, $ServePort)
    & $PythonCommand @PythonArgs -m http.server $ServePort --bind 127.0.0.1 --directory $ServeDir
} -ArgumentList $pythonCommand, $pythonArgs, $dist, $Port

try {
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $status = (Invoke-WebRequest `
                    -Uri "http://127.0.0.1:$Port" `
                    -UseBasicParsing `
                    -TimeoutSec 1).StatusCode
            if ($status -eq 200) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }

    if (-not $ready) {
        throw "Preview server did not start."
    }

    & $browser `
        --headless `
        --disable-gpu `
        --virtual-time-budget=3000 `
        "--screenshot=$Output" `
        --window-size=1360,900 `
        "http://127.0.0.1:$Port"

    if (-not (Test-Path -LiteralPath $Output)) {
        throw "Screenshot was not created."
    }

    Write-Host $Output
} finally {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}
