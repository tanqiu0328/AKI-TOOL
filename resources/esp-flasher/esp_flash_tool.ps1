[CmdletBinding()]
param(
    [ValidateSet("Flash", "Build", "Erase", "Monitor", "Doctor", "ListPorts")]
    [string]$Action = "Flash",

    [string]$Port = "",
    [int]$Baud = 0,
    [int]$MonitorBaud = 0,
    [string]$Chip = "",
    [string]$IdfExport = "",
    [string]$ProjectDir = "",
    [string]$FirmwareDir = "",
    [string]$Config = "",
    [string]$LogDir = "",

    [switch]$SkipBuild,
    [switch]$AutoPort,
    [switch]$OpenMonitorAfterFlash,
    [switch]$DryRun,
    [switch]$NoPause
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:TranscriptStarted = $false

function Write-Step {
    param([string]$Text)

    Write-Host ""
    Write-Host "==> $Text"
}

function Write-Info {
    param([string]$Text)

    Write-Host "    $Text"
}

function Write-Warn {
    param([string]$Text)

    Write-Host "警告: $Text" -ForegroundColor Yellow
}

function Get-ActionLabel {
    param([string]$Name)

    switch ($Name) {
        "Flash" { return "烧录" }
        "Build" { return "编译" }
        "Erase" { return "擦除" }
        "Monitor" { return "串口监视" }
        "Doctor" { return "环境检查" }
        "ListPorts" { return "列出串口" }
        default { return $Name }
    }
}

function Resolve-AbsolutePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Resolve-ConfigPath {
    param(
        [string]$Path,
        [string]$BaseDir
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return (Resolve-AbsolutePath $Path)
    }

    return (Resolve-AbsolutePath (Join-Path $BaseDir $Path))
}

function Get-ConfigProperty {
    param(
        [object]$ConfigObject,
        [string]$Name,
        [object]$DefaultValue
    )

    if ($null -eq $ConfigObject) {
        return $DefaultValue
    }

    $property = $ConfigObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $DefaultValue
    }

    if ($null -eq $property.Value) {
        return $DefaultValue
    }

    if (($property.Value -is [string]) -and
        [string]::IsNullOrWhiteSpace($property.Value)) {
        return $DefaultValue
    }

    return $property.Value
}

function Read-ToolConfig {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } catch {
        throw "配置 JSON 无效: $Path. $($_.Exception.Message)"
    }
}

function Find-IdfExport {
    param([string]$ConfiguredPath)

    if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        return (Resolve-AbsolutePath $ConfiguredPath)
    }

    if (-not [string]::IsNullOrWhiteSpace($env:IDF_PATH)) {
        $fromEnv = Join-Path $env:IDF_PATH "export.bat"
        if (Test-Path -LiteralPath $fromEnv) {
            return (Resolve-AbsolutePath $fromEnv)
        }
    }

    $knownPaths = @(
        "C:\esp\v5.4.4\esp-idf\export.bat",
        "C:\esp\esp-idf\export.bat"
    )

    foreach ($knownPath in $knownPaths) {
        if (Test-Path -LiteralPath $knownPath) {
            return (Resolve-AbsolutePath $knownPath)
        }
    }

    return (Resolve-AbsolutePath $knownPaths[0])
}

function Get-Settings {
    $scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
    $defaultConfig = Join-Path $scriptRoot "flash_tool.config.json"
    if (-not (Test-Path -LiteralPath $defaultConfig)) {
        $defaultConfig = Join-Path $scriptRoot "flash_tool.config.example.json"
    }

    $configPath = $Config
    if ([string]::IsNullOrWhiteSpace($configPath)) {
        $configPath = $defaultConfig
    }
    $configPath = Resolve-AbsolutePath $configPath
    $configBaseDir = Split-Path -Parent $configPath
    $configData = Read-ToolConfig -Path $configPath

    $defaultProjectDir = Resolve-AbsolutePath (Get-Location)
    $projectDirValue = $ProjectDir
    if ([string]::IsNullOrWhiteSpace($projectDirValue)) {
        $projectDirValue = [string](Get-ConfigProperty $configData "projectDir" $defaultProjectDir)
        $projectDirValue = Resolve-ConfigPath $projectDirValue $configBaseDir
    } else {
        $projectDirValue = Resolve-AbsolutePath $projectDirValue
    }

    $defaultFirmwareDir = Join-Path $projectDirValue "build"

    $firmwareDirValue = $FirmwareDir
    if ([string]::IsNullOrWhiteSpace($firmwareDirValue)) {
        $firmwareDirValue = [string](Get-ConfigProperty $configData "firmwareDir" $defaultFirmwareDir)
        $firmwareDirValue = Resolve-ConfigPath $firmwareDirValue $configBaseDir
    } else {
        $firmwareDirValue = Resolve-AbsolutePath $firmwareDirValue
    }

    $logDirValue = $LogDir
    if ([string]::IsNullOrWhiteSpace($logDirValue)) {
        $logDirValue = [string](Get-ConfigProperty $configData "logDir" (Join-Path $scriptRoot "logs"))
        $logDirValue = Resolve-ConfigPath $logDirValue $configBaseDir
    } else {
        $logDirValue = Resolve-AbsolutePath $logDirValue
    }

    $portValue = $Port
    if ([string]::IsNullOrWhiteSpace($portValue)) {
        $portValue = [string](Get-ConfigProperty $configData "port" "COM6")
    }

    $baudValue = $Baud
    if ($baudValue -le 0) {
        $baudValue = [int](Get-ConfigProperty $configData "baud" 115200)
    }

    $monitorBaudValue = $MonitorBaud
    if ($monitorBaudValue -le 0) {
        $monitorBaudValue = [int](Get-ConfigProperty $configData "monitorBaud" 115200)
    }
    Assert-BaudRate -Value $baudValue -Name "Baud"
    Assert-BaudRate -Value $monitorBaudValue -Name "MonitorBaud"

    $chipValue = $Chip
    if ([string]::IsNullOrWhiteSpace($chipValue)) {
        $chipValue = [string](Get-ConfigProperty $configData "chip" "esp32")
    }
    $chipValue = $chipValue.Trim().ToLowerInvariant()
    if ($chipValue -notmatch "^esp[a-z0-9]+$") {
        throw "芯片型号无效: $chipValue。示例: esp32, esp32s3, esp32c3。"
    }

    $idfExportValue = $IdfExport
    if ([string]::IsNullOrWhiteSpace($idfExportValue)) {
        $idfExportValue = [string](Get-ConfigProperty $configData "idfExport" "")
    }
    $idfExportValue = Find-IdfExport -ConfiguredPath $idfExportValue

    $autoPortValue = [bool](Get-ConfigProperty $configData "autoPort" $false)
    if ($AutoPort) {
        $autoPortValue = $true
    }

    $manualDownloadMode = [bool](Get-ConfigProperty $configData "manualDownloadMode" $true)
    $openMonitorValue = [bool](Get-ConfigProperty $configData "openMonitorAfterFlash" $false)
    if ($OpenMonitorAfterFlash) {
        $openMonitorValue = $true
    }

    return [pscustomobject]@{
        Action = $Action
        ScriptRoot = $scriptRoot
        ConfigPath = $configPath
        ProjectDir = $projectDirValue
        FirmwareDir = $firmwareDirValue
        LogDir = $logDirValue
        Port = $portValue
        Chip = $chipValue
        Baud = $baudValue
        MonitorBaud = $monitorBaudValue
        IdfExport = $idfExportValue
        AutoPort = $autoPortValue
        ManualDownloadMode = $manualDownloadMode
        OpenMonitorAfterFlash = $openMonitorValue
        SkipBuild = [bool]$SkipBuild
        DryRun = [bool]$DryRun
        NoPause = [bool]$NoPause
    }
}

function Start-ToolLog {
    param([object]$Settings)

    if ($Settings.DryRun) {
        return
    }

    if (-not (Test-Path -LiteralPath $Settings.LogDir)) {
        New-Item -ItemType Directory -Path $Settings.LogDir -Force | Out-Null
    }

    $logPath = Join-Path $Settings.LogDir (
        "flash-tool-{0}-{1}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), $PID
    )

    try {
        Start-Transcript -Path $logPath -Append | Out-Null
        $script:TranscriptStarted = $true
        Write-Info "Log: $logPath"
    } catch {
        Write-Warn "Could not start log transcript. $($_.Exception.Message)"
    }
}

function Stop-ToolLog {
    if ($script:TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
        } catch {
        }
    }
}

function Get-SerialPortNames {
    $ports = [System.IO.Ports.SerialPort]::GetPortNames()
    return @($ports | Sort-Object {
            if ($_ -match "^COM(\d+)$") {
                [int]$Matches[1]
            } else {
                9999
            }
        }, { $_ })
}

function Assert-SerialPortNameFormat {
    param([string]$Name)

    if ($Name -notmatch "^COM\d+$") {
        throw "串口名称无效: $Name。请使用 COMx 格式，例如 COM6。"
    }
}

function Assert-BaudRate {
    param(
        [int]$Value,
        [string]$Name
    )

    if (($Value -lt 9600) -or ($Value -gt 2000000)) {
        throw "$Name 必须在 9600 到 2000000 之间。"
    }
}

function Get-SerialPortDetails {
    $names = Get-SerialPortNames
    $pnpItems = @()

    try {
        $pnpItems = @(Get-CimInstance Win32_PnPEntity |
            Where-Object { $_.Name -match "\(COM\d+\)" })
    } catch {
        $pnpItems = @()
    }

    foreach ($name in $names) {
        $description = ""
        foreach ($item in $pnpItems) {
            if ($item.Name -match "\($([regex]::Escape($name))\)") {
                $description = $item.Name
                break
            }
        }

        [pscustomobject]@{
            Port = $name
            Description = $description
        }
    }
}

function Show-SerialPorts {
    $ports = @(Get-SerialPortDetails)
    if ($ports.Count -eq 0) {
        Write-Host "未发现串口。"
        return
    }

    $index = 1
    foreach ($port in $ports) {
        if ([string]::IsNullOrWhiteSpace($port.Description)) {
            Write-Host ("{0}. {1}" -f $index, $port.Port)
        } else {
            Write-Host ("{0}. {1} - {2}" -f $index, $port.Port, $port.Description)
        }
        $index++
    }
}

function Resolve-SerialPort {
    param([object]$Settings)

    $port = $Settings.Port
    if (-not $Settings.AutoPort -and
        -not [string]::IsNullOrWhiteSpace($port) -and
        $port.ToUpperInvariant() -ne "AUTO") {
        $port = $port.ToUpperInvariant()
        Assert-SerialPortNameFormat -Name $port
        return $port
    }

    $ports = @(Get-SerialPortNames)
    if ($ports.Count -eq 0) {
        throw "未发现串口。请检查 USB-UART 转接器和驱动。"
    }

    if ($ports.Count -eq 1) {
        Write-Info "已自动选择串口 $($ports[0])。"
        return $ports[0]
    }

    Write-Host "可用串口:"
    Show-SerialPorts

    if ($Settings.NoPause -or $Settings.DryRun) {
        throw "发现多个串口。请指定 -Port COMx。"
    }

    $answer = Read-Host "请选择串口编号，或输入 COM 名称"
    if ($answer -match "^\d+$") {
        $index = [int]$answer
        if (($index -ge 1) -and ($index -le $ports.Count)) {
            return $ports[$index - 1]
        }
    }

    if ($answer -match "^COM\d+$") {
        $selectedPort = $answer.ToUpperInvariant()
        Assert-SerialPortNameFormat -Name $selectedPort
        return $selectedPort
    }

    throw "串口选择无效: $answer"
}

function Test-SerialPort {
    param([string]$Name)

    $ports = Get-SerialPortNames
    return $ports -contains $Name
}

function Assert-SerialPort {
    param([string]$Name)

    Assert-SerialPortNameFormat -Name $Name

    if (-not (Test-SerialPort -Name $Name)) {
        $ports = Get-SerialPortNames
        $portText = "<none>"
        if ($ports.Count -gt 0) {
            $portText = $ports -join ", "
        }

        throw "未找到串口 $Name。当前串口: $portText"
    }
}

function Test-SerialPortAvailable {
    param(
        [string]$Name,
        [int]$BaudRate
    )

    $port = New-Object System.IO.Ports.SerialPort `
        $Name, $BaudRate, `
        ([System.IO.Ports.Parity]::None), 8, `
        ([System.IO.Ports.StopBits]::One)
    $port.ReadTimeout = 200
    $port.WriteTimeout = 200
    $port.DtrEnable = $false
    $port.RtsEnable = $false

    try {
        $port.Open()
        return $true
    } catch {
        return $false
    } finally {
        if ($port.IsOpen) {
            $port.Close()
        }
        $port.Dispose()
    }
}

function Assert-SerialPortAvailable {
    param(
        [string]$Name,
        [int]$BaudRate
    )

    Assert-SerialPort -Name $Name

    if (-not (Test-SerialPortAvailable -Name $Name -BaudRate $BaudRate)) {
        throw "串口 $Name 被占用或无法配置。请关闭串口监视器和卡住的烧录窗口。"
    }
}

function Invoke-CommandLine {
    param(
        [string]$CommandLine,
        [string]$WorkingDirectory,
        [object]$Settings,
        [switch]$NeedsIdf
    )

    $workingPath = Resolve-AbsolutePath $WorkingDirectory
    $usesIdf = $false
    $cmdLine = $CommandLine

    if (-not [string]::IsNullOrWhiteSpace($Settings.IdfExport) -and
        (Test-Path -LiteralPath $Settings.IdfExport)) {
        $cmdLine = "call `"$($Settings.IdfExport)`" >nul && $CommandLine"
        $usesIdf = $true
    } elseif ($NeedsIdf) {
        throw "未找到 ESP-IDF export.bat: $($Settings.IdfExport)"
    } else {
        Write-Warn "未找到 ESP-IDF export.bat，尝试直接执行命令。"
    }

    if ($Settings.DryRun) {
        Write-Host "[dry-run] cd $workingPath"
        if ($usesIdf) {
            Write-Host "[dry-run] cmd.exe /d /c $cmdLine"
        } else {
            Write-Host "[dry-run] cmd.exe /d /c $CommandLine"
        }
        return
    }

    if (-not (Test-Path -LiteralPath $workingPath)) {
        throw "工作目录不存在: $workingPath"
    }

    Push-Location $workingPath
    try {
        & cmd.exe /d /c $cmdLine
        if ($LASTEXITCODE -ne 0) {
            throw "命令执行失败，退出码 $LASTEXITCODE。"
        }
    } finally {
        Pop-Location
    }
}

function Assert-PythonSerialPortAvailable {
    param(
        [string]$Name,
        [int]$BaudRate,
        [string]$WorkingDirectory,
        [object]$Settings
    )

    $pythonCode = "import serial; " +
        "p=serial.Serial('$Name',$BaudRate,timeout=0.2," +
        "write_timeout=0.2,dsrdtr=False,rtscts=False); " +
        "p.dtr=False; p.rts=False; p.close()"

    try {
        Invoke-CommandLine `
            -WorkingDirectory $WorkingDirectory `
            -CommandLine "python -c `"$pythonCode`"" `
            -Settings $Settings
    } catch {
        throw "pySerial 无法初始化 $Name。请检查 USB-UART 驱动、接线和串口监视器。 " +
            "$($_.Exception.Message)"
    }
}

function Get-FlashArgsPath {
    param([object]$Settings)

    return (Join-Path $Settings.FirmwareDir "flash_args")
}

function Get-FlashFiles {
    param([object]$Settings)

    $flashArgs = Get-FlashArgsPath -Settings $Settings
    if (-not (Test-Path -LiteralPath $flashArgs)) {
        return @()
    }

    $files = New-Object System.Collections.Generic.List[string]
    foreach ($line in Get-Content -LiteralPath $flashArgs) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            continue
        }

        if ($trimmed -notmatch "^0x[0-9a-fA-F]+\s+") {
            continue
        }

        $parts = $trimmed -split "\s+"
        if ($parts.Count -ge 2) {
            if ([System.IO.Path]::IsPathRooted($parts[1]) -or
                (($parts[1] -split "[/\\]") -contains "..")) {
                throw "flash_args 中存在不安全的固件路径: $($parts[1])"
            }
            $files.Add($parts[1])
        }
    }

    return @($files)
}

function Assert-FirmwareArtifacts {
    param([object]$Settings)

    $flashArgs = Get-FlashArgsPath -Settings $Settings
    if (-not (Test-Path -LiteralPath $flashArgs)) {
        throw "未找到 flash_args: $flashArgs。请先执行编译。"
    }

    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($relativeFile in (Get-FlashFiles -Settings $Settings)) {
        $path = Join-Path $Settings.FirmwareDir $relativeFile
        if (-not (Test-Path -LiteralPath $path)) {
            $missing.Add($relativeFile)
        }
    }

    if ($missing.Count -gt 0) {
        throw "固件文件缺失，目录 $($Settings.FirmwareDir): " +
            ($missing -join ", ")
    }
}

function Invoke-Build {
    param([object]$Settings)

    Write-Step "编译固件"
    Invoke-CommandLine `
        -WorkingDirectory $Settings.ProjectDir `
        -CommandLine "idf.py build" `
        -Settings $Settings `
        -NeedsIdf
}

function Enter-DownloadMode {
    param([object]$Settings)

    if (-not $Settings.ManualDownloadMode) {
        return
    }

    Write-Step "进入 ESP32 下载模式"
    Write-Host "1. 按住 BOOT/IO0。"
    Write-Host "2. 短按一次 RESET/EN。"
    Write-Host "3. 继续按住 BOOT/IO0。"
    Write-Host "4. 在仍按住 BOOT/IO0 时按 Enter。"
    Write-Host "5. 直到检测到芯片或开始写入后，再松开 BOOT/IO0。"

    if (-not $Settings.DryRun -and -not $Settings.NoPause) {
        Read-Host | Out-Null
    }
}

function Get-BeforeResetMode {
    param([object]$Settings)

    if ($Settings.ManualDownloadMode) {
        return "no_reset"
    }

    return "default_reset"
}

function Get-AfterResetMode {
    param([object]$Settings)

    if ($Settings.ManualDownloadMode) {
        return "no_reset"
    }

    return "hard_reset"
}

function Invoke-Flash {
    param(
        [object]$Settings,
        [string]$ResolvedPort
    )

    if (-not $Settings.SkipBuild) {
        Invoke-Build -Settings $Settings
    } else {
        Write-Step "跳过编译"
    }

    Assert-FirmwareArtifacts -Settings $Settings

    Write-Step "检查串口"
    Assert-SerialPortAvailable -Name $ResolvedPort -BaudRate $Settings.Baud
    Assert-PythonSerialPortAvailable `
        -Name $ResolvedPort `
        -BaudRate $Settings.Baud `
        -WorkingDirectory $Settings.ProjectDir `
        -Settings $Settings

    Enter-DownloadMode -Settings $Settings
    Assert-SerialPort -Name $ResolvedPort

    Write-Step "烧录固件"
    $before = Get-BeforeResetMode -Settings $Settings
    $after = Get-AfterResetMode -Settings $Settings
    $flashCommand = "python -m esptool --chip $($Settings.Chip) -p $ResolvedPort " +
        "-b $($Settings.Baud) --before $before --after $after " +
        "write_flash @flash_args"
    Invoke-CommandLine `
        -WorkingDirectory $Settings.FirmwareDir `
        -CommandLine $flashCommand `
        -Settings $Settings

    Write-Step "完成"
    if ($Settings.ManualDownloadMode) {
        Write-Host "松开 BOOT/IO0，然后短按 RESET/EN 启动固件。"
    }
}

function Invoke-Erase {
    param(
        [object]$Settings,
        [string]$ResolvedPort
    )

    Write-Step "检查串口"
    Assert-SerialPortAvailable -Name $ResolvedPort -BaudRate $Settings.Baud
    Assert-PythonSerialPortAvailable `
        -Name $ResolvedPort `
        -BaudRate $Settings.Baud `
        -WorkingDirectory $Settings.ProjectDir `
        -Settings $Settings

    Enter-DownloadMode -Settings $Settings
    Assert-SerialPort -Name $ResolvedPort

    Write-Step "擦除 Flash"
    $before = Get-BeforeResetMode -Settings $Settings
    $after = Get-AfterResetMode -Settings $Settings
    $eraseCommand = "python -m esptool --chip $($Settings.Chip) -p $ResolvedPort " +
        "-b $($Settings.Baud) --before $before --after $after erase_flash"
    Invoke-CommandLine `
        -WorkingDirectory $Settings.FirmwareDir `
        -CommandLine $eraseCommand `
        -Settings $Settings
}

function Invoke-Monitor {
    param(
        [object]$Settings,
        [string]$ResolvedPort
    )

    Write-Step "打开串口监视"
    Invoke-CommandLine `
        -WorkingDirectory $Settings.ProjectDir `
        -CommandLine "idf.py -p $ResolvedPort -b $($Settings.MonitorBaud) monitor" `
        -Settings $Settings `
        -NeedsIdf
}

function Invoke-Doctor {
    param([object]$Settings)

    $failed = $false
    Write-Step "环境"
    Write-Info "脚本目录    : $($Settings.ScriptRoot)"
    Write-Info "项目目录    : $($Settings.ProjectDir)"
    Write-Info "固件目录    : $($Settings.FirmwareDir)"
    Write-Info "配置文件    : $($Settings.ConfigPath)"
    Write-Info "IDF export  : $($Settings.IdfExport)"
    Write-Info "芯片型号    : $($Settings.Chip)"

    if (-not (Test-Path -LiteralPath $Settings.ProjectDir)) {
        Write-Warn "项目目录不存在。"
        $failed = $true
    }

    if (-not (Test-Path -LiteralPath $Settings.FirmwareDir)) {
        Write-Warn "固件目录不存在。"
        $failed = $true
    }

    if (-not (Test-Path -LiteralPath $Settings.IdfExport)) {
        Write-Warn "未找到 ESP-IDF export.bat。编译和串口监视需要 ESP-IDF。"
    }

    Write-Step "串口列表"
    Show-SerialPorts

    Write-Step "固件文件"
    try {
        Assert-FirmwareArtifacts -Settings $Settings
        foreach ($relativeFile in (Get-FlashFiles -Settings $Settings)) {
            $path = Join-Path $Settings.FirmwareDir $relativeFile
            $size = (Get-Item -LiteralPath $path).Length
            Write-Info "$relativeFile ($size bytes)"
        }
    } catch {
        Write-Warn $_.Exception.Message
        $failed = $true
    }

    Write-Step "Python 模块"
    try {
        Invoke-CommandLine `
            -WorkingDirectory $Settings.ProjectDir `
            -CommandLine "python -c `"import serial, esptool; print('pyserial and esptool OK')`"" `
            -Settings $Settings
    } catch {
        Write-Warn $_.Exception.Message
        $failed = $true
    }

    if ($failed) {
        throw "环境检查发现问题。请先处理上面的警告，再执行烧录。"
    }
}

function Wait-BeforeExit {
    param([object]$Settings)

    if (-not $Settings.NoPause -and -not $Settings.DryRun) {
        Write-Host ""
        Read-Host "按 Enter 退出" | Out-Null
    }
}

$settings = Get-Settings

try {
    Start-ToolLog -Settings $settings

    Write-Step "AKI-TOOL ESP 烧录"
    Write-Info "操作: $(Get-ActionLabel $settings.Action)"

    switch ($settings.Action) {
        "ListPorts" {
            Show-SerialPorts
        }
        "Doctor" {
            Invoke-Doctor -Settings $settings
        }
        "Build" {
            Invoke-Build -Settings $settings
        }
        "Flash" {
            $resolvedPort = Resolve-SerialPort -Settings $settings
            Write-Info "串口: $resolvedPort"
            Invoke-Flash -Settings $settings -ResolvedPort $resolvedPort
            if ($settings.OpenMonitorAfterFlash) {
                Invoke-Monitor -Settings $settings -ResolvedPort $resolvedPort
            }
        }
        "Erase" {
            $resolvedPort = Resolve-SerialPort -Settings $settings
            Write-Info "串口: $resolvedPort"
            Invoke-Erase -Settings $settings -ResolvedPort $resolvedPort
        }
        "Monitor" {
            $resolvedPort = Resolve-SerialPort -Settings $settings
            Write-Info "串口: $resolvedPort"
            Invoke-Monitor -Settings $settings -ResolvedPort $resolvedPort
        }
        default {
            throw "不支持的操作: $($settings.Action)"
        }
    }

    Stop-ToolLog
    exit 0
} catch {
    Write-Host ""
    Write-Host "失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "重试检查:"
    Write-Host "- 烧录前关闭串口监视器。"
    Write-Host "- 关闭任何卡在 Connecting... 的烧录窗口。"
    Write-Host "- 如果串口消失，重新插拔 USB-UART 转接器。"
    Write-Host "- 按住 BOOT/IO0，短按 RESET/EN，然后按 Enter。"
    Write-Host "- 检测到芯片前保持 BOOT/IO0 按下。"
    Stop-ToolLog
    Wait-BeforeExit -Settings $settings
    exit 1
}
