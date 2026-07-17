import { contextBridge, ipcRenderer } from "electron";

type EspAction = "Doctor" | "ListPorts" | "Build" | "Flash" | "Erase" | "Monitor";

type EspConfig = {
  chip: string;
  port: string;
  baud: number;
  monitorBaud: number;
  idfExport: string;
  projectDir: string;
  firmwareDir: string;
  skipBuildOnFlash: boolean;
  autoPort: boolean;
  manualDownloadMode: boolean;
  openMonitorAfterFlash: boolean;
  logDir: string;
};

type SerialConnectionStatus = "closed" | "opening" | "open" | "closing" | "reconnecting" | "error";

type LowerBoardSimConfig = {
  port: string;
  deviceType: number;
  busVoltageV: number;
  boardTemperatureC: number;
  faultCode: number;
  speedRampRpmPerSecond: number;
  responseDelayMs: number;
  offlineMode: boolean;
  dropRatePercent: number;
  badChecksumRatePercent: number;
};

type LowerBoardSimCommandFrame = {
  deviceType: number;
  run: boolean;
  targetSpeedRpm: number;
  faultClear: boolean;
  reserved: number;
};

type LowerBoardSimStatusFrame = {
  deviceType: number;
  currentSpeedRpm: number;
  busVoltageV: number;
  busCurrentMa: number;
  motorPowerW: number;
  boardTemperatureC: number;
  faultCode: number;
};

type LowerBoardSimStats = {
  rxBytes: number;
  txBytes: number;
  commandFrames: number;
  statusFrames: number;
  crcErrors: number;
  syncErrors: number;
  droppedResponses: number;
  badChecksumResponses: number;
  faultClearPulses: number;
  lastCommand?: LowerBoardSimCommandFrame;
  lastStatus?: LowerBoardSimStatusFrame;
};

type LowerBoardSimStatusEvent = {
  status: SerialConnectionStatus;
  running: boolean;
  message: string;
  port: string;
  config: LowerBoardSimConfig;
  stats: LowerBoardSimStats;
  timestamp: number;
};

type LowerBoardSimFrameEvent = {
  direction: "rx" | "tx";
  frameType: "command" | "status" | "error";
  hex: string;
  message: string;
  command?: LowerBoardSimCommandFrame;
  statusFrame?: LowerBoardSimStatusFrame;
  timestamp: number;
};

contextBridge.exposeInMainWorld("aki", {
  getMeta: () => ipcRenderer.invoke("app:get-meta"),
  esp: {
    getConfig: () => ipcRenderer.invoke("esp:get-config"),
    saveConfig: (config: EspConfig) => ipcRenderer.invoke("esp:save-config", config),
    listPorts: () => ipcRenderer.invoke("esp:list-ports"),
    runAction: (action: EspAction, config: EspConfig) =>
      ipcRenderer.invoke("esp:run-action", { action, config }),
    stopAction: () => ipcRenderer.invoke("esp:stop-action"),
    onActionOutput: (callback: (event: { id: string; stream: "stdout" | "stderr"; text: string }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: { id: string; stream: "stdout" | "stderr"; text: string }) =>
        callback(payload);
      ipcRenderer.on("esp:action-output", listener);
      return () => ipcRenderer.removeListener("esp:action-output", listener);
    },
    onActionFinished: (callback: (event: { id: string; exitCode: number | null; signal: string | null }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: { id: string; exitCode: number | null; signal: string | null }) =>
        callback(payload);
      ipcRenderer.on("esp:action-finished", listener);
      return () => ipcRenderer.removeListener("esp:action-finished", listener);
    }
  },
  lowerBoardSim: {
    getConfig: () => ipcRenderer.invoke("lower-board-sim:get-config"),
    saveConfig: (config: LowerBoardSimConfig) => ipcRenderer.invoke("lower-board-sim:save-config", config),
    listPorts: () => ipcRenderer.invoke("lower-board-sim:list-ports"),
    start: (config: LowerBoardSimConfig) => ipcRenderer.invoke("lower-board-sim:start", config),
    stop: () => ipcRenderer.invoke("lower-board-sim:stop"),
    updateConfig: (config: LowerBoardSimConfig) => ipcRenderer.invoke("lower-board-sim:update-config", config),
    resetStats: () => ipcRenderer.invoke("lower-board-sim:reset-stats"),
    onStatus: (callback: (event: LowerBoardSimStatusEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: LowerBoardSimStatusEvent) => callback(payload);
      ipcRenderer.on("lower-board-sim:status", listener);
      return () => ipcRenderer.removeListener("lower-board-sim:status", listener);
    },
    onFrame: (callback: (event: LowerBoardSimFrameEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: LowerBoardSimFrameEvent) => callback(payload);
      ipcRenderer.on("lower-board-sim:frame", listener);
      return () => ipcRenderer.removeListener("lower-board-sim:frame", listener);
    }
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
    selectFile: (options?: { title?: string; filters?: Electron.FileFilter[] }) =>
      ipcRenderer.invoke("dialog:select-file", options)
  },
  shell: {
    openPath: (targetPath: string) => ipcRenderer.invoke("shell:open-path", targetPath)
  }
});
