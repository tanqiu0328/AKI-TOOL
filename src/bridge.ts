import type {
  ActionFinishedEvent,
  ActionOutputEvent,
  AkiApi,
  EspAction,
  EspConfig,
  LowerBoardSimConfig,
  LowerBoardSimFrameEvent,
  LowerBoardSimStats,
  LowerBoardSimStatusEvent
} from "./types";

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

const fallbackLowerBoardSimConfig: LowerBoardSimConfig = {
  port: "COM9",
  deviceType: 0x02,
  busVoltageV: 230,
  boardTemperatureC: 25,
  faultCode: 0,
  speedRampRpmPerSecond: 1200,
  responseDelayMs: 10,
  offlineMode: false,
  dropRatePercent: 0,
  badChecksumRatePercent: 0
};

const outputListeners = new Set<(event: ActionOutputEvent) => void>();
const finishedListeners = new Set<(event: ActionFinishedEvent) => void>();
const lowerBoardSimStatusListeners = new Set<(event: LowerBoardSimStatusEvent) => void>();
const lowerBoardSimFrameListeners = new Set<(event: LowerBoardSimFrameEvent) => void>();

let fallbackConfigState = { ...fallbackConfig };
let fallbackLowerBoardSimConfigState = { ...fallbackLowerBoardSimConfig };
let fallbackRunningId = "";
let fallbackLowerBoardSimOpen = false;
let fallbackLowerBoardSimTimer: number | null = null;
let fallbackLowerBoardSimSpeed = 0;
let fallbackLowerBoardSimStats: LowerBoardSimStats = {
  rxBytes: 0,
  txBytes: 0,
  commandFrames: 0,
  statusFrames: 0,
  crcErrors: 0,
  syncErrors: 0,
  droppedResponses: 0,
  badChecksumResponses: 0,
  faultClearPulses: 0
};
function emitOutput(event: ActionOutputEvent) {
  outputListeners.forEach((listener) => listener(event));
}

function emitFinished(event: ActionFinishedEvent) {
  finishedListeners.forEach((listener) => listener(event));
}

function emitLowerBoardSimStatus(event: LowerBoardSimStatusEvent) {
  lowerBoardSimStatusListeners.forEach((listener) => listener(event));
}

function emitLowerBoardSimFrame(event: LowerBoardSimFrameEvent) {
  lowerBoardSimFrameListeners.forEach((listener) => listener(event));
}

function fallbackLowerBoardSimStatus(status: LowerBoardSimStatusEvent["status"], message: string): LowerBoardSimStatusEvent {
  return {
    status,
    running: fallbackLowerBoardSimOpen,
    message,
    port: fallbackLowerBoardSimConfigState.port,
    config: { ...fallbackLowerBoardSimConfigState },
    stats: {
      ...fallbackLowerBoardSimStats,
      lastCommand: fallbackLowerBoardSimStats.lastCommand ? { ...fallbackLowerBoardSimStats.lastCommand } : undefined,
      lastStatus: fallbackLowerBoardSimStats.lastStatus ? { ...fallbackLowerBoardSimStats.lastStatus } : undefined
    },
    timestamp: Date.now()
  };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function xor8(bytes: Uint8Array, length: number) {
  let checksum = 0;
  for (let index = 0; index < length; index += 1) {
    checksum ^= bytes[index] ?? 0;
  }
  return checksum & 0xff;
}

function resetFallbackLowerBoardSimStats() {
  fallbackLowerBoardSimStats = {
    rxBytes: 0,
    txBytes: 0,
    commandFrames: 0,
    statusFrames: 0,
    crcErrors: 0,
    syncErrors: 0,
    droppedResponses: 0,
    badChecksumResponses: 0,
    faultClearPulses: 0
  };
}

function emitFallbackLowerBoardSimExchange() {
  if (!fallbackLowerBoardSimOpen) {
    return;
  }

  const command = {
    deviceType: 0x02,
    run: false,
    targetSpeedRpm: 0,
    faultClear: false,
    reserved: 0
  };
  const commandFrame = new Uint8Array([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  commandFrame[8] = xor8(commandFrame, 8);

  fallbackLowerBoardSimStats.rxBytes += commandFrame.length;
  fallbackLowerBoardSimStats.commandFrames += 1;
  fallbackLowerBoardSimStats.lastCommand = command;
  emitLowerBoardSimFrame({
    direction: "rx",
    frameType: "command",
    hex: bytesToHex(commandFrame),
    message: "预览命令 run=0 speed=0 faultClear=0",
    command,
    timestamp: Date.now()
  });

  if (fallbackLowerBoardSimConfigState.offlineMode || fallbackLowerBoardSimConfigState.dropRatePercent >= 100) {
    fallbackLowerBoardSimStats.droppedResponses += 1;
    emitLowerBoardSimStatus(fallbackLowerBoardSimStatus("open", "预览离线: 已抑制回包"));
    return;
  }

  fallbackLowerBoardSimSpeed = Math.max(0, fallbackLowerBoardSimSpeed - 120);
  const statusFrame = {
    deviceType: fallbackLowerBoardSimConfigState.deviceType,
    currentSpeedRpm: fallbackLowerBoardSimSpeed,
    busVoltageV: fallbackLowerBoardSimConfigState.busVoltageV,
    busCurrentMa: 0,
    motorPowerW: 0,
    boardTemperatureC: fallbackLowerBoardSimConfigState.boardTemperatureC,
    faultCode: fallbackLowerBoardSimConfigState.faultCode
  };
  const frame = new Uint8Array(15);
  frame[0] = 0x5a;
  frame[1] = 0xa5;
  frame[2] = statusFrame.deviceType;
  frame[5] = (statusFrame.busVoltageV >> 8) & 0xff;
  frame[6] = statusFrame.busVoltageV & 0xff;
  frame[11] = Math.max(0, Math.min(255, statusFrame.boardTemperatureC + 40));
  frame[12] = (statusFrame.faultCode >> 8) & 0xff;
  frame[13] = statusFrame.faultCode & 0xff;
  frame[14] = xor8(frame, 14);

  fallbackLowerBoardSimStats.txBytes += frame.length;
  fallbackLowerBoardSimStats.statusFrames += 1;
  fallbackLowerBoardSimStats.lastStatus = statusFrame;
  emitLowerBoardSimFrame({
    direction: "tx",
    frameType: "status",
    hex: bytesToHex(frame),
    message: "预览状态帧",
    statusFrame,
    timestamp: Date.now()
  });
  emitLowerBoardSimStatus(fallbackLowerBoardSimStatus("open", "预览模式运行中"));
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
    lowerBoardSim: {
      getConfig: async () => ({
        config: fallbackLowerBoardSimConfigState,
        configPath: "浏览器预览模式"
      }),
      saveConfig: async (config) => {
        fallbackLowerBoardSimConfigState = { ...config };
        return { config: fallbackLowerBoardSimConfigState, configPath: "浏览器预览模式" };
      },
      listPorts: async () => [
        { path: "COM9", manufacturer: "AKI lower-board simulator mock" },
        { path: "COM10", manufacturer: "USB-TTL mock adapter" }
      ],
      start: async (config) => {
        fallbackLowerBoardSimConfigState = { ...config };
        fallbackLowerBoardSimOpen = true;
        fallbackLowerBoardSimSpeed = 0;
        resetFallbackLowerBoardSimStats();
        const status = fallbackLowerBoardSimStatus("open", `预览模式已启动 ${fallbackLowerBoardSimConfigState.port}`);
        window.setTimeout(() => emitLowerBoardSimStatus(status), 0);
        if (fallbackLowerBoardSimTimer !== null) {
          window.clearInterval(fallbackLowerBoardSimTimer);
        }
        fallbackLowerBoardSimTimer = window.setInterval(emitFallbackLowerBoardSimExchange, 520);
        window.setTimeout(emitFallbackLowerBoardSimExchange, 80);
        return status;
      },
      stop: async () => {
        fallbackLowerBoardSimOpen = false;
        if (fallbackLowerBoardSimTimer !== null) {
          window.clearInterval(fallbackLowerBoardSimTimer);
          fallbackLowerBoardSimTimer = null;
        }
        const status = fallbackLowerBoardSimStatus("closed", "预览模式已停止");
        window.setTimeout(() => emitLowerBoardSimStatus(status), 0);
        return status;
      },
      updateConfig: async (config) => {
        fallbackLowerBoardSimConfigState = { ...config };
        const status = fallbackLowerBoardSimStatus(fallbackLowerBoardSimOpen ? "open" : "closed", "预览配置已应用");
        window.setTimeout(() => emitLowerBoardSimStatus(status), 0);
        return status;
      },
      resetStats: async () => {
        resetFallbackLowerBoardSimStats();
        const status = fallbackLowerBoardSimStatus(fallbackLowerBoardSimOpen ? "open" : "closed", "预览统计已复位");
        window.setTimeout(() => emitLowerBoardSimStatus(status), 0);
        return status;
      },
      onStatus: (callback) => {
        lowerBoardSimStatusListeners.add(callback);
        return () => lowerBoardSimStatusListeners.delete(callback);
      },
      onFrame: (callback) => {
        lowerBoardSimFrameListeners.add(callback);
        return () => lowerBoardSimFrameListeners.delete(callback);
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
