import type {
  LowerBoardSimAdapter,
  LowerBoardSimPortInfo
} from "../shared/lowerBoardSimulation.js";

export type EspAction = "Doctor" | "ListPorts" | "Build" | "Flash" | "Erase" | "Monitor";

export type ToolId = "esp" | "lowerBoardSim";

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

export type SerialConnectionStatus = "closed" | "opening" | "open" | "closing" | "error";

export type SerialPortInfo = LowerBoardSimPortInfo;


export type LowerBoardSimConfig = {
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

export type LowerBoardSimCommandFrame = {
  deviceType: number;
  run: boolean;
  targetSpeedRpm: number;
  faultClear: boolean;
  reserved: number;
};

export type LowerBoardSimStatusFrame = {
  deviceType: number;
  currentSpeedRpm: number;
  busVoltageV: number;
  busCurrentMa: number;
  motorPowerW: number;
  boardTemperatureC: number;
  faultCode: number;
};

export type LowerBoardSimStats = {
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

export type LowerBoardSimStatusEvent = {
  status: SerialConnectionStatus;
  running: boolean;
  message: string;
  port: string;
  config: LowerBoardSimConfig;
  stats: LowerBoardSimStats;
  timestamp: number;
};

export type LowerBoardSimFrameEvent = {
  direction: "rx" | "tx";
  frameType: "command" | "status" | "error";
  hex: string;
  message: string;
  command?: LowerBoardSimCommandFrame;
  statusFrame?: LowerBoardSimStatusFrame;
  timestamp: number;
};

export type LowerBoardSimConfigPayload = {
  config: LowerBoardSimConfig;
  configPath: string;
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
  lowerBoardSim: LowerBoardSimAdapter;
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
