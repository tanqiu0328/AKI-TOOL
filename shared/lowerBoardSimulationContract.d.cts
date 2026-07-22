// 使用 CommonJS 声明文件，让 ESM Renderer 与 CommonJS preload 共用同一份纯类型 contract
export type SerialConnectionStatus = "closed" | "opening" | "open" | "closing" | "error";

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

export type LowerBoardSimPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
};

export type LowerBoardSimAdapter = {
  getConfig: () => Promise<{ config: LowerBoardSimConfig; configPath: string }>;
  saveConfig: (config: LowerBoardSimConfig) => Promise<{ config: LowerBoardSimConfig; configPath: string }>;
  listPorts: () => Promise<LowerBoardSimPortInfo[]>;
  start: (config: LowerBoardSimConfig) => Promise<LowerBoardSimStatusEvent>;
  stop: () => Promise<LowerBoardSimStatusEvent>;
  updateConfig: (config: LowerBoardSimConfig) => Promise<LowerBoardSimStatusEvent>;
  resetStats: () => Promise<LowerBoardSimStatusEvent>;
  onStatus: (callback: (event: LowerBoardSimStatusEvent) => void) => () => void;
  onFrame: (callback: (event: LowerBoardSimFrameEvent) => void) => () => void;
};
