import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repositoryRoot, "resources", "esp-flasher", "esp_flash_tool.ps1");

test("本机后端 dry-run 在容量预检和文件复核后才提交 write_flash", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aki-custom-flash-capacity-"));
  const imagePath = path.join(temporaryDir, "factory.bin");
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
        "-CustomFlashItemsJson",
        JSON.stringify([
          { name: "出厂数据", filePath: imagePath, address: "0x10000", expectedFileSize: 4096 }
        ]),
        "-FlashCapacityBytes",
        String(4 * 1024 * 1024),
        "-DryRun",
        "-NoPause"
      ],
      { cwd: repositoryRoot, encoding: "utf8" }
    );

    const capacityIndex = output.indexOf("探测实际 Flash 容量");
    const recheckIndex = output.indexOf("写入前重新检查");
    const writeIndex = output.indexOf("write_flash");
    assert.ok(capacityIndex >= 0);
    assert.ok(recheckIndex > capacityIndex);
    assert.ok(writeIndex > recheckIndex);
    assert.match(output, /实际 Flash 容量: 0x400000.*4194304 字节/);
    assert.equal(output.match(/write_flash/g)?.length, 1);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("本机后端 dry-run 通过一次命令批量提交地址与文件配对", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aki-custom-flash-"));
  const factoryImagePath = path.join(temporaryDir, "factory data.bin");
  const configImagePath = path.join(temporaryDir, "device config.bin");
  fs.writeFileSync(factoryImagePath, Buffer.alloc(4096));
  fs.writeFileSync(configImagePath, Buffer.alloc(2048));
  const itemsJson = JSON.stringify([
    { name: "出厂数据", filePath: factoryImagePath, address: "0x10000", expectedFileSize: 4096 },
    { name: "设备配置", filePath: configImagePath, address: "0x12000", expectedFileSize: 2048 }
  ]);

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
        "-CustomFlashItemsJson",
        itemsJson,
        "-FlashCapacityBytes",
        String(4 * 1024 * 1024),
        "-DryRun",
        "-NoPause"
      ],
      { cwd: repositoryRoot, encoding: "utf8" }
    );

    assert.match(output, /操作: 自定义烧录/);
    assert.match(output, /芯片: esp32s3/);
    assert.match(output, /串口: COM9/);
    const command = output.match(/write_flash[^\r\n]+/)?.[0] ?? "";
    assert.match(command, /0x10000 "[^"]*factory data\.bin"/);
    assert.match(command, /0x12000 "[^"]*device config\.bin"/);
    assert.equal(output.match(/write_flash/g)?.length, 1);
    assert.match(output, /不具备事务式回滚/);
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

test("本机后端拒绝零字节自定义烧录文件", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aki-custom-flash-empty-"));
  const imagePath = path.join(temporaryDir, "empty.bin");
  fs.writeFileSync(imagePath, Buffer.alloc(0));

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
            "-CustomFlashItemsJson",
            JSON.stringify([
              { name: "空镜像", filePath: imagePath, address: "0x10000", expectedFileSize: 0 }
            ]),
            "-DryRun",
            "-NoPause"
          ],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }
        ),
      (error) => {
        const failure = error as { stdout?: unknown; stderr?: unknown };
        const output = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
        assert.match(output, /文件大小必须大于 0 字节/);
        assert.doesNotMatch(output, /write_flash/);
        return true;
      }
    );
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});
