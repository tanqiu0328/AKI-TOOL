import type {
  EspActionFinishedEvent,
  EspActionOutputEvent,
  EspToolAdapter
} from "../shared/espToolContract.cjs";

type ElectronEspIpcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => unknown;
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => unknown;
};

function createElectronEspToolAdapter(ipcRenderer: ElectronEspIpcRenderer): EspToolAdapter {
  return {
    getConfig: () => ipcRenderer.invoke("esp:get-config") as ReturnType<EspToolAdapter["getConfig"]>,
    saveConfig: (config) =>
      ipcRenderer.invoke("esp:save-config", config) as ReturnType<EspToolAdapter["saveConfig"]>,
    listPorts: () => ipcRenderer.invoke("esp:list-ports") as ReturnType<EspToolAdapter["listPorts"]>,
    runAction: (action, config) =>
      ipcRenderer.invoke("esp:run-action", { action, config }) as ReturnType<EspToolAdapter["runAction"]>,
    stopAction: () => ipcRenderer.invoke("esp:stop-action") as ReturnType<EspToolAdapter["stopAction"]>,
    onActionOutput: (callback) => {
      const listener = (_event: unknown, payload: unknown) => callback(payload as EspActionOutputEvent);
      ipcRenderer.on("esp:action-output", listener);
      return () => ipcRenderer.removeListener("esp:action-output", listener);
    },
    onActionFinished: (callback) => {
      const listener = (_event: unknown, payload: unknown) => callback(payload as EspActionFinishedEvent);
      ipcRenderer.on("esp:action-finished", listener);
      return () => ipcRenderer.removeListener("esp:action-finished", listener);
    }
  };
}

module.exports = { createElectronEspToolAdapter };
