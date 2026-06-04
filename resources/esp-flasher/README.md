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
- `Flash`
- `Erase`
- `Monitor`

`flash_tool.config.example.json` is the generic default. Keep project-specific paths in the saved user config, not in this template.
