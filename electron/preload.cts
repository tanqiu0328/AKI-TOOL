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

type SerialParity = "none" | "even" | "odd" | "mark" | "space";
type SerialTextEncoding = "utf-8" | "gbk";
type SerialDisplayMode = "text" | "hex";
type SerialDataBits = 5 | 6 | 7 | 8;
type SerialStopBits = 1 | 1.5 | 2;

type SerialConfig = {
  port: string;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  textEncoding: SerialTextEncoding;
  receiveMode: SerialDisplayMode;
  sendMode: SerialDisplayMode;
  showTimestamp: boolean;
  frameGapMs: number;
  terminalMode: boolean;
  showSent: boolean;
  timedSend: boolean;
  timedSendIntervalMs: number;
  autoOpen: boolean;
  autoReconnect: boolean;
  dtr: boolean;
  rts: boolean;
};

type SerialLineSignals = {
  dtr: boolean;
  rts: boolean;
  cts: boolean | null;
  dsr: boolean | null;
  dcd: boolean | null;
};

type SerialDataEvent = {
  direction: "rx" | "tx";
  base64: string;
  byteLength: number;
  timestamp: number;
};

type SerialStatusEvent = {
  status: "closed" | "opening" | "open" | "closing" | "reconnecting" | "error";
  connected: boolean;
  message: string;
  port: string;
  signals: SerialLineSignals;
  timestamp: number;
};

type SerialWritePayload = {
  data: string;
  mode: SerialDisplayMode;
  encoding: SerialTextEncoding;
  appendLineEnding?: boolean;
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
  serial: {
    getConfig: () => ipcRenderer.invoke("serial:get-config"),
    saveConfig: (config: SerialConfig) => ipcRenderer.invoke("serial:save-config", config),
    listPorts: () => ipcRenderer.invoke("serial:list-ports"),
    open: (config: SerialConfig) => ipcRenderer.invoke("serial:open", config),
    close: () => ipcRenderer.invoke("serial:close"),
    write: (payload: SerialWritePayload) => ipcRenderer.invoke("serial:write", payload),
    setControlLines: (signals: Pick<SerialLineSignals, "dtr" | "rts">) =>
      ipcRenderer.invoke("serial:set-control-lines", signals),
    onData: (callback: (event: SerialDataEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: SerialDataEvent) => callback(payload);
      ipcRenderer.on("serial:data", listener);
      return () => ipcRenderer.removeListener("serial:data", listener);
    },
    onStatus: (callback: (event: SerialStatusEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: SerialStatusEvent) => callback(payload);
      ipcRenderer.on("serial:status", listener);
      return () => ipcRenderer.removeListener("serial:status", listener);
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
