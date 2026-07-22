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
    inspectCustomFlashFile: (filePath) =>
      ipcRenderer.invoke("esp:inspect-custom-flash-file", filePath) as ReturnType<
        EspToolAdapter["inspectCustomFlashFile"]
      >,
    listCustomFlashPlans: () =>
      ipcRenderer.invoke("esp:list-custom-flash-plans") as ReturnType<EspToolAdapter["listCustomFlashPlans"]>,
    saveCustomFlashPlan: (plan) =>
      ipcRenderer.invoke("esp:save-custom-flash-plan", plan) as ReturnType<EspToolAdapter["saveCustomFlashPlan"]>,
    deleteCustomFlashPlan: (planId) =>
      ipcRenderer.invoke("esp:delete-custom-flash-plan", planId) as ReturnType<
        EspToolAdapter["deleteCustomFlashPlan"]
      >,
    runCustomFlash: (request) =>
      ipcRenderer.invoke("esp:run-custom-flash", {
        ...request,
        items: request.items.filter((item) => item.enabled)
      }) as ReturnType<EspToolAdapter["runCustomFlash"]>,
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
