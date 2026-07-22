import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repositoryRoot, "resources", "esp-flasher", "esp_flash_tool.ps1");

test("本机后端 dry-run 独立执行单项自定义烧录", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aki-custom-flash-"));
  const imagePath = path.join(temporaryDir, "factory data.bin");
  fs.writeFileSync(imagePath, Buffer.alloc(4096));

  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Action",
        "CustomFlash",
        "-Port",
        "COM9",
        "-Chip",
        "esp32s3",
        "-Baud",
        "460800",
        "-CustomFlashFile",
        imagePath,
        "-CustomFlashAddress",
        "0x10000",
        "-ExpectedCustomFlashSize",
        "4096",
        "-DryRun",
        "-NoPause"
      ],
      { cwd: repositoryRoot, encoding: "utf8" }
    );

    assert.match(output, /操作: 自定义烧录/);
    assert.match(output, /芯片: esp32s3/);
    assert.match(output, /串口: COM9/);
    assert.match(output, /write_flash 0x10000 "[^"]*factory data\.bin"/);
    assert.doesNotMatch(output, /编译|flash_args|串口监视/);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("本机后端拒绝确认后大小发生变化的自定义烧录文件", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aki-custom-flash-size-"));
  const imagePath = path.join(temporaryDir, "factory.bin");
  fs.writeFileSync(imagePath, Buffer.alloc(4096));

  try {
    assert.throws(
      () =>
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-Action",
            "CustomFlash",
            "-Port",
            "COM9",
            "-CustomFlashFile",
            imagePath,
            "-CustomFlashAddress",
            "0x10000",
            "-ExpectedCustomFlashSize",
            "2048",
            "-DryRun",
            "-NoPause"
          ],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }
      ),
      (error) => {
        const failure = error as { stdout?: unknown; stderr?: unknown };
        const output = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
        assert.match(output, /文件大小已变化/);
        assert.doesNotMatch(output, /write_flash/);
        return true;
      }
    );
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});
