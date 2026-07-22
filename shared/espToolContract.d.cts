// 使用 CommonJS 声明文件，让 ESM Renderer 与 CommonJS preload 共用同一份纯类型 contract
export type EspAction = "Doctor" | "ListPorts" | "Build" | "Flash" | "Erase" | "Monitor";

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

export type EspConfigPayload = {
  config: EspConfig;
  configPath: string;
  toolDir: string;
  userDataDir: string;
};

export type EspActionOutputEvent = {
  id: string;
  stream: "stdout" | "stderr";
  text: string;
};

export type EspActionFinishedEvent = {
  id: string;
  exitCode: number | null;
  signal: string | null;
};

export type CustomFlashItem = {
  name: string;
  filePath: string;
  address: string;
  enabled: boolean;
};

export type CustomFlashRequestItem = CustomFlashItem & {
  expectedFileSize: number;
};

export type CustomFlashFileInspection = {
  filePath: string;
  fileName: string;
  size: number;
  exists: boolean;
};

export type CustomFlashRequest = {
  config: EspConfig;
  items: CustomFlashRequestItem[];
};

export type EspToolAdapter = {
  getConfig: () => Promise<EspConfigPayload>;
  saveConfig: (config: EspConfig) => Promise<{ config: EspConfig; configPath: string }>;
  listPorts: () => Promise<string[]>;
  runAction: (action: EspAction, config: EspConfig) => Promise<{ id: string }>;
  inspectCustomFlashFile: (filePath: string) => Promise<CustomFlashFileInspection>;
  runCustomFlash: (request: CustomFlashRequest) => Promise<{ id: string }>;
  stopAction: () => Promise<boolean>;
  onActionOutput: (callback: (event: EspActionOutputEvent) => void) => () => void;
  onActionFinished: (callback: (event: EspActionFinishedEvent) => void) => () => void;
};
