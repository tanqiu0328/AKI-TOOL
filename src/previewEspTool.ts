import type {
  CustomFlashRequest,
  EspAction,
  EspActionFinishedEvent,
  EspActionOutputEvent,
  EspConfig,
  EspToolAdapter
} from "../shared/espToolContract.cjs";

export const previewEspConfig: EspConfig = {
  chip: "esp32",
  port: "COM3",
  baud: 460800,
  monitorBaud: 115200,
  idfExport: "C:\\esp\\v5.4.4\\esp-idf\\export.bat",
  projectDir: "",
  firmwareDir: "",
  skipBuildOnFlash: true,
  autoPort: false,
  manualDownloadMode: true,
  openMonitorAfterFlash: false,
  logDir: "logs"
};

export type PreviewEspToolClock = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
};

export type PreviewEspToolDependencies = {
  clock: PreviewEspToolClock;
  createId: () => string;
};

function getActionLabel(action: EspAction) {
  switch (action) {
    case "Doctor":
      return "环境检查";
    case "Build":
      return "编译";
    case "Flash":
      return "烧录";
    case "Erase":
      return "擦除";
    case "Monitor":
      return "串口监视";
    case "ListPorts":
      return "列出串口";
  }
}

function getFileName(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export function createPreviewEspToolAdapter(
  dependencies: PreviewEspToolDependencies = {
    clock: { setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) },
    createId: () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
): EspToolAdapter {
  let config = { ...previewEspConfig };
  let runningId = "";
  const outputListeners = new Set<(event: EspActionOutputEvent) => void>();
  const finishedListeners = new Set<(event: EspActionFinishedEvent) => void>();

  function emitOutput(event: EspActionOutputEvent) {
    outputListeners.forEach((listener) => listener(event));
  }

  function emitFinished(event: EspActionFinishedEvent) {
    finishedListeners.forEach((listener) => listener(event));
  }

  function scheduleAction(id: string, lines: string[]) {
    lines.forEach((line, index) => {
      dependencies.clock.setTimeout(() => {
        if (runningId === id) {
          emitOutput({ id, stream: "stdout", text: `${line}\n` });
        }
      }, 120 + index * 90);
    });
    dependencies.clock.setTimeout(() => {
      if (runningId === id) {
        runningId = "";
        emitFinished({ id, exitCode: 0, signal: null });
      }
    }, 1100);
  }

  const adapter: EspToolAdapter = {
    getConfig: async () => ({
      config: { ...config },
      configPath: "浏览器预览模式",
      toolDir: "resources/esp-flasher",
      userDataDir: "浏览器预览模式"
    }),
    saveConfig: async (nextConfig) => {
      config = { ...nextConfig };
      return { config: { ...config }, configPath: "浏览器预览模式" };
    },
    listPorts: async () => ["COM3", "COM6"],
    runAction: async (action, nextConfig) => {
      config = { ...nextConfig };
      const id = dependencies.createId();
      runningId = id;
      const lines = [
        `==> AKI-TOOL ESP ${getActionLabel(action)}`,
        `    芯片: ${config.chip}`,
        `    串口: ${config.port}`,
        `    波特率: ${config.baud}`,
        `    项目目录: ${config.projectDir || "<未设置>"}`,
        `    固件目录: ${config.firmwareDir || "<未设置>"}`,
        "",
        "浏览器预览模式未调用本机烧录后端。"
      ];

      scheduleAction(id, lines);

      return { id };
    },
    inspectCustomFlashFile: async (filePath) => ({
      filePath,
      fileName: getFileName(filePath),
      size: filePath ? 4096 : 0,
      exists: Boolean(filePath)
    }),
    runCustomFlash: async (request: CustomFlashRequest) => {
      config = { ...request.config };
      const id = dependencies.createId();
      runningId = id;
      const lines = [
        "==> AKI-TOOL ESP 自定义烧录",
        `    芯片: ${config.chip}`,
        `    串口: ${config.port}`,
        `    波特率: ${config.baud}`,
        `    自定义烧录项: ${request.item.name}`,
        `    文件: ${request.item.filePath}`,
        `    起始地址: ${request.item.address}`,
        "",
        "浏览器预览模式未调用本机烧录后端。"
      ];

      scheduleAction(id, lines);

      return { id };
    },
    stopAction: async () => {
      const id = runningId;
      runningId = "";
      if (id) {
        emitOutput({ id, stream: "stderr", text: "任务已停止。\n" });
        emitFinished({ id, exitCode: null, signal: "SIGTERM" });
      }
      return Boolean(id);
    },
    onActionOutput: (callback) => {
      outputListeners.add(callback);
      return () => outputListeners.delete(callback);
    },
    onActionFinished: (callback) => {
      finishedListeners.add(callback);
      return () => finishedListeners.delete(callback);
    }
  };

  return adapter;
}

class PreviewTestClock implements PreviewEspToolClock {
  private timestamp = 0;
  private nextHandle = 1;
  private timers = new Map<number, { callback: () => void; dueAt: number }>();

  setTimeout(callback: () => void, delayMs: number) {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, dueAt: this.timestamp + delayMs });
    return handle;
  }

  advanceBy(milliseconds: number) {
    this.timestamp += milliseconds;
    const dueTimers = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.timestamp)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);

    for (const [handle, timer] of dueTimers) {
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

export function createPreviewEspToolHarness() {
  const clock = new PreviewTestClock();
  let nextId = 1;
  const adapter = createPreviewEspToolAdapter({
    clock,
    createId: () => `preview-${nextId++}`
  });

  return {
    adapter,
    advanceBy: (milliseconds: number) => clock.advanceBy(milliseconds)
  };
}
