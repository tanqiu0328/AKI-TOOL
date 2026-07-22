# AKI-TOOL ESP Flasher

This directory contains the PowerShell backend used by the AKI-TOOL ESP flashing module.

The desktop UI stores the editable config in the app data directory and calls:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File esp_flash_tool.ps1 -Action Doctor
```

Supported actions:

- `Doctor`
- `ListPorts`
- `Build`
- `CustomFlash`
- `Flash`
- `Erase`
- `Monitor`

`flash_tool.config.example.json` is the generic default. Keep project-specific paths in the saved user config, not in this template.

## 自定义烧录容量预检

Electron 会在真实自定义烧录写入前通过 `esptool flash_id` 读取设备实际 Flash 容量，后端随后重新检查文件元数据和地址范围

`-FlashCapacityBytes` 承载 Electron 已探测的容量；`-DryRun` 自动化测试可通过该参数注入可控容量且不访问硬件

## 真实硬件人工冒烟验证

1. 连接一块已知 Flash 容量的 ESP 设备，并在 AKI-TOOL 中选择对应芯片、串口和烧录波特率
2. 若启用手动下载模式，先让设备进入下载模式，再确认一个地址范围明确位于容量内的自定义烧录项
3. 确认统一日志依次显示容量探测、实际容量、写入前重新检查和单次 `write_flash`，并确认烧录成功
4. 将同一文件的起始地址调整到会越过实际容量的位置后再次确认，检查日志明确显示容量与越界范围，且不出现 `write_flash`
