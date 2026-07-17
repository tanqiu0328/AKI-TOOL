import type {
  ActionFinishedEvent,
  ActionOutputEvent,
  AkiApi,
  EspAction,
  EspConfig
} from "./types";
import { createPreviewLowerBoardSimHarness } from "./previewLowerBoardSim";

const fallbackConfig: EspConfig = {
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

const outputListeners = new Set<(event: ActionOutputEvent) => void>();
const finishedListeners = new Set<(event: ActionFinishedEvent) => void>();

let fallbackConfigState = { ...fallbackConfig };
let fallbackRunningId = "";
function emitOutput(event: ActionOutputEvent) {
  outputListeners.forEach((listener) => listener(event));
}

function emitFinished(event: ActionFinishedEvent) {
  finishedListeners.forEach((listener) => listener(event));
}

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

function createFallbackApi(): AkiApi {
  const lowerBoardSim = createPreviewLowerBoardSimHarness({ autoInput: true }).adapter;

  return {
    getMeta: async () => ({ name: "AKI-TOOL", version: "0.1.0-preview" }),
    esp: {
      getConfig: async () => ({
        config: fallbackConfigState,
        configPath: "浏览器预览模式",
        toolDir: "resources/esp-flasher",
        userDataDir: "浏览器预览模式"
      }),
      saveConfig: async (config) => {
        fallbackConfigState = { ...config };
        return { config: fallbackConfigState, configPath: "浏览器预览模式" };
      },
      listPorts: async () => ["COM3", "COM6"],
      runAction: async (action, config) => {
        fallbackConfigState = { ...config };
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        fallbackRunningId = id;

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

        lines.forEach((line, index) => {
          window.setTimeout(() => {
            if (fallbackRunningId === id) {
              emitOutput({ id, stream: "stdout", text: `${line}\n` });
            }
          }, 120 + index * 90);
        });

        window.setTimeout(() => {
          if (fallbackRunningId === id) {
            fallbackRunningId = "";
            emitFinished({ id, exitCode: 0, signal: null });
          }
        }, 1100);

        return { id };
      },
      stopAction: async () => {
        const id = fallbackRunningId;
        fallbackRunningId = "";
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
    },
    lowerBoardSim,
    dialog: {
      selectDirectory: async () => "",
      selectFile: async () => ""
    },
    shell: {
      openPath: async () => ""
    }
  };
}

export function getAkiApi() {
  return window.aki ?? createFallbackApi();
}
