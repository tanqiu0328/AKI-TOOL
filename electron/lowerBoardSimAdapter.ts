import type {
  LowerBoardSimAdapter,
  LowerBoardSimPortInfo,
  LowerBoardSimulationSession,
  LowerBoardSimulationTransport,
  LowerBoardSimulationTransportHandlers
} from "../shared/lowerBoardSimulation.js";

export type ElectronSerialPortInfo = LowerBoardSimPortInfo;

export type ElectronSerialPortOpenOptions = {
  path: string;
  baudRate: 4800;
  dataBits: 8;
  parity: "none";
  stopBits: 1;
  autoOpen: false;
};

export type ElectronSerialPort = {
  isOpen: boolean;
  open: (callback: (error?: Error | null) => void) => void;
  write: (data: Uint8Array, callback: (error?: Error | null) => void) => void;
  drain: (callback: (error?: Error | null) => void) => void;
  close: (callback: (error?: Error | null) => void) => void;
  on: {
    (event: "data", listener: (data: Uint8Array) => void): ElectronSerialPort;
    (event: "error", listener: (error: Error) => void): ElectronSerialPort;
    (event: "close", listener: (error?: Error) => void): ElectronSerialPort;
  };
};

export type SerialPortLowerBoardSimulationTransportDependencies = {
  createPort: (options: ElectronSerialPortOpenOptions) => ElectronSerialPort;
  resolvePort?: (requestedPort: string) => Promise<string>;
};

export function createSerialPortLowerBoardSimulationTransport(
  dependencies: SerialPortLowerBoardSimulationTransportDependencies
): LowerBoardSimulationTransport {
  let currentPort: ElectronSerialPort | undefined;

  return {
    async open(options, handlers: LowerBoardSimulationTransportHandlers) {
      const resolvedPort = dependencies.resolvePort
        ? await dependencies.resolvePort(options.port)
        : options.port;
      const port = dependencies.createPort({
        path: resolvedPort,
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        parity: options.parity,
        stopBits: options.stopBits,
        autoOpen: false
      });
      currentPort = port;
      port.on("data", (data) => handlers.onData(Uint8Array.from(data)));
      port.on("error", (error) => handlers.onError(error));
      port.on("close", (error) => {
        if (currentPort === port) {
          currentPort = undefined;
        }
        handlers.onClose(error);
      });

      await new Promise<void>((resolve, reject) => {
        port.open((error) => {
          if (error) {
            if (currentPort === port) {
              currentPort = undefined;
            }
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async write(data) {
      const port = currentPort;
      if (!port?.isOpen) {
        throw new Error("下板模拟串口未打开");
      }

      await new Promise<void>((resolve, reject) => {
        port.write(data, (writeError) => {
          if (writeError) {
            reject(writeError);
            return;
          }
          port.drain((drainError) => {
            if (drainError) {
              reject(drainError);
              return;
            }
            resolve();
          });
        });
      });
    },
    async close() {
      const port = currentPort;
      if (!port) {
        return;
      }
      if (!port.isOpen) {
        currentPort = undefined;
        return;
      }

      await new Promise<void>((resolve, reject) => {
        port.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          if (currentPort === port) {
            currentPort = undefined;
          }
          resolve();
        });
      });
    }
  };
}

export type ElectronLowerBoardSimAdapter = LowerBoardSimAdapter;

export type ElectronLowerBoardSimAdapterDependencies = {
  session: LowerBoardSimulationSession;
  configPath: string;
  listPorts: () => Promise<ElectronSerialPortInfo[]>;
};

export function createElectronLowerBoardSimAdapter(
  dependencies: ElectronLowerBoardSimAdapterDependencies
): ElectronLowerBoardSimAdapter {
  return {
    getConfig: async () => ({
      config: await dependencies.session.loadConfig(),
      configPath: dependencies.configPath
    }),
    saveConfig: async (config) => ({
      config: await dependencies.session.saveConfig(config),
      configPath: dependencies.configPath
    }),
    listPorts: dependencies.listPorts,
    start: (config) => dependencies.session.start(config),
    stop: () => dependencies.session.stop(),
    updateConfig: (config) => dependencies.session.applyConfig(config),
    resetStats: async () => dependencies.session.resetStats(),
    onStatus: (callback) => dependencies.session.onStatus(callback),
    onFrame: (callback) => dependencies.session.onFrame(callback)
  };
}
