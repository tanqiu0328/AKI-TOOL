export type EspAction = "Doctor" | "ListPorts" | "Build" | "Flash" | "Erase" | "Monitor";

export type ToolId = "esp" | "serial";

export type EspConfig = {
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

export type AppMeta = {
  name: string;
  version: string;
};

export type EspConfigPayload = {
  config: EspConfig;
  configPath: string;
  toolDir: string;
  userDataDir: string;
};

export type ActionOutputEvent = {
  id: string;
  stream: "stdout" | "stderr";
  text: string;
};

export type ActionFinishedEvent = {
  id: string;
  exitCode: number | null;
  signal: string | null;
};

export type SerialParity = "none" | "even" | "odd" | "mark" | "space";

export type SerialTextEncoding = "utf-8" | "gbk";

export type SerialDisplayMode = "text" | "hex";

export type SerialConnectionStatus = "closed" | "opening" | "open" | "closing" | "reconnecting" | "error";

export type SerialDataBits = 5 | 6 | 7 | 8;

export type SerialStopBits = 1 | 1.5 | 2;

export type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
};

export type SerialLineSignals = {
  dtr: boolean;
  rts: boolean;
  cts: boolean | null;
  dsr: boolean | null;
  dcd: boolean | null;
};

export type SerialConfig = {
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

export type SerialConfigPayload = {
  config: SerialConfig;
  configPath: string;
};

export type SerialDataEvent = {
  direction: "rx" | "tx";
  base64: string;
  byteLength: number;
  timestamp: number;
};

export type SerialStatusEvent = {
  status: SerialConnectionStatus;
  connected: boolean;
  message: string;
  port: string;
  signals: SerialLineSignals;
  timestamp: number;
};

export type SerialWritePayload = {
  data: string;
  mode: SerialDisplayMode;
  encoding: SerialTextEncoding;
  appendLineEnding?: boolean;
};

export type AkiApi = {
  getMeta: () => Promise<AppMeta>;
  esp: {
    getConfig: () => Promise<EspConfigPayload>;
    saveConfig: (config: EspConfig) => Promise<{ config: EspConfig; configPath: string }>;
    listPorts: () => Promise<string[]>;
    runAction: (action: EspAction, config: EspConfig) => Promise<{ id: string }>;
    stopAction: () => Promise<boolean>;
    onActionOutput: (callback: (event: ActionOutputEvent) => void) => () => void;
    onActionFinished: (callback: (event: ActionFinishedEvent) => void) => () => void;
  };
  serial: {
    getConfig: () => Promise<SerialConfigPayload>;
    saveConfig: (config: SerialConfig) => Promise<SerialConfigPayload>;
    listPorts: () => Promise<SerialPortInfo[]>;
    open: (config: SerialConfig) => Promise<SerialStatusEvent>;
    close: () => Promise<SerialStatusEvent>;
    write: (payload: SerialWritePayload) => Promise<{ bytesWritten: number }>;
    setControlLines: (signals: Pick<SerialLineSignals, "dtr" | "rts">) => Promise<SerialLineSignals>;
    onData: (callback: (event: SerialDataEvent) => void) => () => void;
    onStatus: (callback: (event: SerialStatusEvent) => void) => () => void;
  };
  dialog: {
    selectDirectory: () => Promise<string>;
    selectFile: (options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<string>;
  };
  shell: {
    openPath: (targetPath: string) => Promise<string>;
  };
};
