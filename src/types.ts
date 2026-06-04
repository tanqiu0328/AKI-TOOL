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
