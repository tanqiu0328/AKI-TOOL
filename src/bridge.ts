import type {
  ActionFinishedEvent,
  ActionOutputEvent,
  AkiApi,
  EspAction,
  EspConfig,
  SerialConfig,
  SerialDataEvent,
  SerialLineSignals,
  SerialStatusEvent
} from "./types";

const fallbackConfig: EspConfig = {
  chip: "esp32",
  port: "AUTO",
  baud: 460800,
  monitorBaud: 115200,
  idfExport: "C:\\esp\\v5.4.4\\esp-idf\\export.bat",
  projectDir: "",
  firmwareDir: "",
  skipBuildOnFlash: true,
  autoPort: true,
  manualDownloadMode: true,
  openMonitorAfterFlash: false,
  logDir: "logs"
};

const fallbackSerialConfig: SerialConfig = {
  port: "COM3",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  textEncoding: "utf-8",
  receiveMode: "text",
  sendMode: "text",
  showTimestamp: true,
  frameGapMs: 20,
  terminalMode: false,
  showSent: true,
  timedSend: false,
  timedSendIntervalMs: 1000,
  autoOpen: false,
  autoReconnect: true,
  dtr: false,
  rts: false
};

const outputListeners = new Set<(event: ActionOutputEvent) => void>();
const finishedListeners = new Set<(event: ActionFinishedEvent) => void>();
const serialDataListeners = new Set<(event: SerialDataEvent) => void>();
const serialStatusListeners = new Set<(event: SerialStatusEvent) => void>();

let fallbackConfigState = { ...fallbackConfig };
let fallbackSerialConfigState = { ...fallbackSerialConfig };
let fallbackRunningId = "";
let fallbackSerialOpen = false;
let fallbackSerialSignals: SerialLineSignals = {
  dtr: false,
  rts: false,
  cts: null,
  dsr: null,
  dcd: null
};

function emitOutput(event: ActionOutputEvent) {
  outputListeners.forEach((listener) => listener(event));
}

function emitFinished(event: ActionFinishedEvent) {
  finishedListeners.forEach((listener) => listener(event));
}

function emitSerialData(event: SerialDataEvent) {
  serialDataListeners.forEach((listener) => listener(event));
}

function emitSerialStatus(event: SerialStatusEvent) {
  serialStatusListeners.forEach((listener) => listener(event));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fallbackSerialStatus(status: SerialStatusEvent["status"], message: string): SerialStatusEvent {
  return {
    status,
    connected: fallbackSerialOpen,
    message,
    port: fallbackSerialConfigState.port,
    signals: fallbackSerialSignals,
    timestamp: Date.now()
  };
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
    serial: {
      getConfig: async () => ({
        config: fallbackSerialConfigState,
        configPath: "浏览器预览模式"
      }),
      saveConfig: async (config) => {
        fallbackSerialConfigState = { ...config };
        fallbackSerialSignals = {
          ...fallbackSerialSignals,
          dtr: config.dtr,
          rts: config.rts
        };
        return { config: fallbackSerialConfigState, configPath: "浏览器预览模式" };
      },
      listPorts: async () => [
        { path: "COM3", manufacturer: "AKI mock device" },
        { path: "COM6", manufacturer: "USB-SERIAL CH340" }
      ],
      open: async (config) => {
        fallbackSerialConfigState = { ...config, port: config.port === "AUTO" ? "COM3" : config.port };
        fallbackSerialSignals = {
          ...fallbackSerialSignals,
          dtr: config.dtr,
          rts: config.rts
        };
        fallbackSerialOpen = true;
        const status = fallbackSerialStatus("open", `已打开 ${fallbackSerialConfigState.port}`);
        window.setTimeout(() => emitSerialStatus(status), 0);
        window.setTimeout(() => {
          if (fallbackSerialOpen) {
            const text = "AKI-TOOL mock serial ready\r\n";
            emitSerialData({
              direction: "rx",
              base64: bytesToBase64(new TextEncoder().encode(text)),
              byteLength: text.length,
              timestamp: Date.now()
            });
          }
        }, 260);
        return status;
      },
      close: async () => {
        fallbackSerialOpen = false;
        const status = fallbackSerialStatus("closed", "串口已关闭");
        window.setTimeout(() => emitSerialStatus(status), 0);
        return status;
      },
      write: async (payload) => {
        if (!fallbackSerialOpen) {
          throw new Error("串口未打开。");
        }

        const data = payload.mode === "text" ? payload.data + (payload.appendLineEnding ? "\r\n" : "") : payload.data;
        const bytes = new TextEncoder().encode(data);
        const event: SerialDataEvent = {
          direction: "tx",
          base64: bytesToBase64(bytes),
          byteLength: bytes.length,
          timestamp: Date.now()
        };
        window.setTimeout(() => emitSerialData(event), 0);
        window.setTimeout(() => {
          if (fallbackSerialOpen) {
            emitSerialData({
              ...event,
              direction: "rx",
              timestamp: Date.now()
            });
          }
        }, 120);
        return { bytesWritten: bytes.length };
      },
      setControlLines: async (signals) => {
        fallbackSerialSignals = {
          ...fallbackSerialSignals,
          dtr: signals.dtr,
          rts: signals.rts
        };
        emitSerialStatus(fallbackSerialStatus(fallbackSerialOpen ? "open" : "closed", "控制线已更新"));
        return fallbackSerialSignals;
      },
      onData: (callback) => {
        serialDataListeners.add(callback);
        return () => serialDataListeners.delete(callback);
      },
      onStatus: (callback) => {
        serialStatusListeners.add(callback);
        return () => serialStatusListeners.delete(callback);
      }
    },
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
