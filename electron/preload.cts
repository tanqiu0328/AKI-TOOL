import { contextBridge, ipcRenderer } from "electron";

type LowerBoardSimAdapter = import("../shared/lowerBoardSimulationContract.cjs").LowerBoardSimAdapter;
type EspToolAdapter = import("../shared/espToolContract.cjs").EspToolAdapter;
const { createElectronEspToolAdapter } = require("./espToolAdapter.cjs") as {
  createElectronEspToolAdapter: (renderer: typeof ipcRenderer) => EspToolAdapter;
};

const lowerBoardSim: LowerBoardSimAdapter = {
  getConfig: () => ipcRenderer.invoke("lower-board-sim:get-config"),
  saveConfig: (config) => ipcRenderer.invoke("lower-board-sim:save-config", config),
  listPorts: () => ipcRenderer.invoke("lower-board-sim:list-ports"),
  start: (config) => ipcRenderer.invoke("lower-board-sim:start", config),
  stop: () => ipcRenderer.invoke("lower-board-sim:stop"),
  updateConfig: (config) => ipcRenderer.invoke("lower-board-sim:update-config", config),
  resetStats: () => ipcRenderer.invoke("lower-board-sim:reset-stats"),
  onStatus: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on("lower-board-sim:status", listener);
    return () => ipcRenderer.removeListener("lower-board-sim:status", listener);
  },
  onFrame: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on("lower-board-sim:frame", listener);
    return () => ipcRenderer.removeListener("lower-board-sim:frame", listener);
  }
};

contextBridge.exposeInMainWorld("aki", {
  getMeta: () => ipcRenderer.invoke("app:get-meta"),
  esp: createElectronEspToolAdapter(ipcRenderer),
  lowerBoardSim,
  dialog: {
    selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
    selectFile: (options?: { title?: string; filters?: Electron.FileFilter[] }) =>
      ipcRenderer.invoke("dialog:select-file", options)
  },
  shell: {
    openPath: (targetPath: string) => ipcRenderer.invoke("shell:open-path", targetPath)
  }
});
