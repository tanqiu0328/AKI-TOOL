import assert from "node:assert/strict";
import test from "node:test";
import type { CustomFlashRequest, EspConfig } from "../shared/espToolContract.d.cts";
import {
  createElectronCustomFlashAdapter,
  type CustomFlashFileMetadata
} from "../electron/customFlashAdapter.ts";

const config: EspConfig = {
  chip: "esp32s3",
  port: "COM9",
  baud: 460800,
  monitorBaud: 115200,
  idfExport: "C:\\esp\\export.bat",
  projectDir: "C:\\project",
  firmwareDir: "C:\\firmware",
  skipBuildOnFlash: true,
  autoPort: false,
  manualDownloadMode: true,
  openMonitorAfterFlash: false,
  logDir: "logs"
};

const request: CustomFlashRequest = {
  config,
  items: [
    {
      name: "设备数据",
      filePath: "C:\\images\\device.bin",
      address: "0x10000",
      enabled: true,
      expectedFile: { size: 8192, modifiedAtMs: 1000, createdAtMs: 500 }
    }
  ]
};

const unchangedMetadata: CustomFlashFileMetadata = {
  filePath: "C:\\images\\device.bin",
  exists: true,
  size: 8192,
  modifiedAtMs: 1000,
  createdAtMs: 500
};

test("Electron 自定义烧录适配器在容量探测和二次文件检查后只启动一次写入", async () => {
  const calls: string[] = [];
  const adapter = createElectronCustomFlashAdapter({
    inspectFile: () => {
      calls.push("inspect");
      return unchangedMetadata;
    },
    probeFlashCapacity: async (receivedConfig) => {
      calls.push("probe");
      assert.deepEqual(receivedConfig, config);
      return 4 * 1024 * 1024;
    },
    startWrite: async (_receivedRequest, preflight) => {
      calls.push("write");
      assert.equal(preflight.flashCapacityBytes, 4 * 1024 * 1024);
      assert.deepEqual(preflight.files, [unchangedMetadata]);
      return { id: "custom-flash-1" };
    }
  });

  assert.deepEqual(await adapter.runCustomFlash(request), { id: "custom-flash-1" });
  assert.deepEqual(calls, ["inspect", "probe", "inspect", "write"]);
});

test("Electron 自定义烧录适配器拒绝摘要确认后首次检查前发生的同大小替换", async () => {
  let writeCount = 0;
  const adapter = createElectronCustomFlashAdapter({
    inspectFile: () => ({ ...unchangedMetadata, modifiedAtMs: 2000, createdAtMs: 1500 }),
    probeFlashCapacity: async () => 4 * 1024 * 1024,
    startWrite: async () => {
      writeCount += 1;
      return { id: "unexpected-write" };
    }
  });

  await assert.rejects(adapter.runCustomFlash(request), /确认后已被替换或修改/);
  assert.equal(writeCount, 0);
});

test("Electron 自定义烧录适配器拒绝超过实际 Flash 容量的地址范围", async () => {
  let writeCount = 0;
  const adapter = createElectronCustomFlashAdapter({
    inspectFile: () => unchangedMetadata,
    probeFlashCapacity: async () => 4 * 1024 * 1024,
    startWrite: async () => {
      writeCount += 1;
      return { id: "unexpected-write" };
    }
  });

  await assert.rejects(
    adapter.runCustomFlash({
      ...request,
      items: [{ ...request.items[0], address: "0x3ff000" }]
    }),
    (error) => {
      assert.match(String(error), /实际 Flash 容量 0x400000/);
      assert.match(String(error), /0x3ff000.*0x400fff/);
      return true;
    }
  );
  assert.equal(writeCount, 0);
});

test("Electron 自定义烧录适配器在容量探测失败时给出可操作反馈且不写入", async () => {
  let writeCount = 0;
  const adapter = createElectronCustomFlashAdapter({
    inspectFile: () => unchangedMetadata,
    probeFlashCapacity: async () => {
      throw new Error("esptool 无法连接设备");
    },
    startWrite: async () => {
      writeCount += 1;
      return { id: "unexpected-write" };
    }
  });

  await assert.rejects(
    adapter.runCustomFlash(request),
    (error) => {
      assert.match(String(error), /无法读取目标设备实际 Flash 容量/);
      assert.match(String(error), /esptool 无法连接设备/);
      assert.match(String(error), /串口.*下载模式/);
      return true;
    }
  );
  assert.equal(writeCount, 0);
});

test("Electron 自定义烧录适配器拒绝容量探测期间发生变化的已确认文件", async (context) => {
  const cases: Array<{ name: string; changed: CustomFlashFileMetadata; message: RegExp }> = [
    {
      name: "文件被删除",
      changed: { ...unchangedMetadata, exists: false, size: 0 },
      message: /文件不存在/
    },
    {
      name: "文件大小变化",
      changed: { ...unchangedMetadata, size: 4096, modifiedAtMs: 2000 },
      message: /文件大小已变化.*确认时 8192 字节.*当前 4096 字节/
    },
    {
      name: "同大小文件被替换",
      changed: { ...unchangedMetadata, modifiedAtMs: 2000, createdAtMs: 1500 },
      message: /确认后已被替换或修改/
    }
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      let inspectionCount = 0;
      let writeCount = 0;
      const adapter = createElectronCustomFlashAdapter({
        inspectFile: () => {
          inspectionCount += 1;
          return inspectionCount === 1 ? unchangedMetadata : scenario.changed;
        },
        probeFlashCapacity: async () => 4 * 1024 * 1024,
        startWrite: async () => {
          writeCount += 1;
          return { id: "unexpected-write" };
        }
      });

      await assert.rejects(adapter.runCustomFlash(request), scenario.message);
      assert.equal(writeCount, 0);
    });
  }
});
