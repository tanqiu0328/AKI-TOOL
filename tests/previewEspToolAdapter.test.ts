import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreviewEspToolHarness,
  previewEspConfig
} from "../src/previewEspTool.ts";
import type {
  EspAction,
  EspActionFinishedEvent,
  EspActionOutputEvent
} from "../shared/espToolContract.d.cts";
import { defineEspToolAdapterContract } from "./espToolAdapterContract.ts";

defineEspToolAdapterContract(() => {
  const harness = createPreviewEspToolHarness();

  return {
    adapter: harness.adapter,
    initialConfig: previewEspConfig,
    ports: ["COM3", "COM6"],
    customFlashItems: [
      {
        name: "出厂数据",
        filePath: "C:\\preview\\factory.bin",
        address: "0x9000",
        enabled: true,
        expectedFile: { size: 4096, modifiedAtMs: 1000, createdAtMs: 500 }
      },
      {
        name: "设备配置",
        filePath: "C:\\preview\\config.bin",
        address: "0xa000",
        enabled: true,
        expectedFile: { size: 4096, modifiedAtMs: 1000, createdAtMs: 500 }
      }
    ],
    customFlashInspections: [
      {
        filePath: "C:\\preview\\factory.bin",
        fileName: "factory.bin",
        size: 4096,
        exists: true,
        modifiedAtMs: 1000,
        createdAtMs: 500
      },
      {
        filePath: "C:\\preview\\config.bin",
        fileName: "config.bin",
        size: 4096,
        exists: true,
        modifiedAtMs: 1000,
        createdAtMs: 500
      }
    ],
    completeAction: async () => harness.advanceBy(2000)
  };
});

test("浏览器预览可演示现有 ESP 动作且不调用本机后端", async () => {
  const harness = createPreviewEspToolHarness();
  const outputEvents: EspActionOutputEvent[] = [];
  const finishedEvents: EspActionFinishedEvent[] = [];
  const actions: EspAction[] = ["Doctor", "Build", "Flash", "Erase", "Monitor"];
  harness.adapter.onActionOutput((event) => outputEvents.push(event));
  harness.adapter.onActionFinished((event) => finishedEvents.push(event));

  for (const action of actions) {
    await harness.adapter.runAction(action, previewEspConfig);
    harness.advanceBy(1100);
  }

  assert.equal(finishedEvents.length, actions.length);
  assert.ok(outputEvents.some((event) => event.text.includes("环境检查")));
  assert.ok(outputEvents.some((event) => event.text.includes("编译")));
  assert.ok(outputEvents.some((event) => event.text.includes("烧录")));
  assert.ok(outputEvents.some((event) => event.text.includes("擦除")));
  assert.ok(outputEvents.some((event) => event.text.includes("串口监视")));
  assert.equal(
    outputEvents.filter((event) => event.text.includes("浏览器预览模式未调用本机烧录后端")).length,
    actions.length
  );
});
