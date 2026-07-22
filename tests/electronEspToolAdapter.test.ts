import { createRequire } from "node:module";
import type {
  CustomFlashPlan,
  CustomFlashRequestItem,
  EspConfig,
  EspConfigPayload,
  EspToolAdapter
} from "../shared/espToolContract.d.cts";
import {
  removeCustomFlashPlan,
  upsertCustomFlashPlan,
  validateCustomFlashItems
} from "../shared/customFlash.ts";
import { defineEspToolAdapterContract } from "./espToolAdapterContract.ts";

const require = createRequire(import.meta.url);

const initialConfig: EspConfig = {
  chip: "esp32",
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

class TestEspIpcRenderer {
  private config = { ...initialConfig };
  private customFlashPlans: CustomFlashPlan[] = [];
  private runningId = "";
  private nextId = 1;
  private listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();

  async invoke(channel: string, ...args: unknown[]) {
    switch (channel) {
      case "esp:get-config":
        return this.configPayload();
      case "esp:save-config":
        this.config = { ...(args[0] as EspConfig) };
        return {
          config: { ...this.config },
          configPath: "C:\\AKI\\flash_tool.config.json"
        };
      case "esp:list-ports":
        return ["COM9", "COM10"];
      case "esp:run-action": {
        const payload = args[0] as { config: EspConfig };
        this.config = { ...payload.config };
        this.runningId = `electron-${this.nextId}`;
        this.nextId += 1;
        return { id: this.runningId };
      }
      case "esp:inspect-custom-flash-file": {
        const filePath = String(args[0]);
        return {
          filePath,
          fileName: "device.bin",
          size: 8192,
          exists: true
        };
      }
      case "esp:list-custom-flash-plans":
        return structuredClone(this.customFlashPlans);
      case "esp:save-custom-flash-plan": {
        const result = upsertCustomFlashPlan(this.customFlashPlans, args[0] as CustomFlashPlan);
        this.customFlashPlans = result.plans;
        return structuredClone(result.savedPlan);
      }
      case "esp:delete-custom-flash-plan": {
        const result = removeCustomFlashPlan(this.customFlashPlans, String(args[0]));
        this.customFlashPlans = result.plans;
        return result.deleted;
      }
      case "esp:run-custom-flash": {
        const request = args[0] as {
          config: EspConfig;
          items: CustomFlashRequestItem[];
        };
        const items = validateCustomFlashItems(request.items);
        this.config = { ...request.config };
        this.runningId = `electron-${this.nextId}`;
        this.nextId += 1;
        this.emit("esp:action-output", {
          id: this.runningId,
          stream: "stdout",
          text: `${items.map((item) => `${item.name} ${item.address}`).join(" ")}\n`
        });
        return { id: this.runningId };
      }
      case "esp:stop-action": {
        const id = this.runningId;
        this.runningId = "";
        if (id) {
          this.emit("esp:action-output", { id, stream: "stderr", text: "任务已停止。\n" });
          this.emit("esp:action-finished", { id, exitCode: null, signal: "SIGTERM" });
        }
        return Boolean(id);
      }
      default:
        throw new Error(`未处理的 IPC channel: ${channel}`);
    }
  }

  on(channel: string, listener: (event: unknown, payload: unknown) => void) {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return this;
  }

  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void) {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }

  completeAction(id: string) {
    if (this.runningId !== id) {
      throw new Error(`没有运行中的动作: ${id}`);
    }
    this.emit("esp:action-output", { id, stream: "stdout", text: "动作输出\n" });
    this.emit("esp:action-finished", { id, exitCode: 0, signal: null });
    this.runningId = "";
  }

  private configPayload(): EspConfigPayload {
    return {
      config: { ...this.config },
      configPath: "C:\\AKI\\flash_tool.config.json",
      toolDir: "C:\\AKI\\esp-flasher",
      userDataDir: "C:\\AKI"
    };
  }

  private emit(channel: string, payload: unknown) {
    this.listeners.get(channel)?.forEach((listener) => listener({}, payload));
  }
}

const { createElectronEspToolAdapter } = require("../electron/espToolAdapter.cts") as {
  createElectronEspToolAdapter: (ipcRenderer: TestEspIpcRenderer) => EspToolAdapter;
};

defineEspToolAdapterContract(() => {
  const ipcRenderer = new TestEspIpcRenderer();

  return {
    adapter: createElectronEspToolAdapter(ipcRenderer),
    initialConfig,
    ports: ["COM9", "COM10"],
    customFlashItems: [
      {
        name: "设备数据",
        filePath: "C:\\images\\device.bin",
        address: "0x10000",
        enabled: true,
        expectedFileSize: 8192
      },
      {
        name: "校准数据",
        filePath: "C:\\images\\calibration.bin",
        address: "0x12000",
        enabled: true,
        expectedFileSize: 4096
      }
    ],
    customFlashInspections: [
      {
        filePath: "C:\\images\\device.bin",
        fileName: "device.bin",
        size: 8192,
        exists: true
      },
      {
        filePath: "C:\\images\\calibration.bin",
        fileName: "device.bin",
        size: 8192,
        exists: true
      }
    ],
    completeAction: async (id) => ipcRenderer.completeAction(id)
  };
});
