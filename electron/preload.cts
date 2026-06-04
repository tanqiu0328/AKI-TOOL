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
  dialog: {
    selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
    selectFile: (options?: { title?: string; filters?: Electron.FileFilter[] }) =>
      ipcRenderer.invoke("dialog:select-file", options)
  },
  shell: {
    openPath: (targetPath: string) => ipcRenderer.invoke("shell:open-path", targetPath)
  }
});
