import {
  createLowerBoardSimulationSession,
  defaultLowerBoardSimConfig,
  type LowerBoardSimConfig,
  type LowerBoardSimulationClock,
  type LowerBoardSimulationRandom,
  type LowerBoardSimulationTransport,
  type LowerBoardSimulationTransportHandlers
} from "../shared/lowerBoardSimulation.ts";
import type { AkiApi } from "./types.ts";

const previewConfigPath = "浏览器预览模式";
const previewCommandIntervalMs = 500;
const previewRandomSequence = [0.8, 0.2, 0.2, 0.8, 0.8] as const;

// 固定向量只负责提供预览输入，协议解析、状态演进和回包编码均由共享会话完成
const previewCommandFrames = [
  Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x05, 0xdc, 0x00, 0x00, 0x25]),
  Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x09, 0xc4, 0x00, 0x00, 0x31]),
  Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]),
  Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0xfc])
] as const;

export const previewLowerBoardSimConfig: LowerBoardSimConfig = {
  ...defaultLowerBoardSimConfig,
  port: "COM9"
};

class PreviewClock implements LowerBoardSimulationClock {
  private currentTime = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now() {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(Number(handle));
  }

  advanceBy(milliseconds: number) {
    const targetTime = this.currentTime + Math.max(0, milliseconds);

    for (;;) {
      const nextTimer = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.at <= targetTime)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];

      if (!nextTimer) {
        break;
      }

      const [id, timer] = nextTimer;
      this.timers.delete(id);
      this.currentTime = timer.at;
      timer.callback();
    }

    this.currentTime = targetTime;
  }

  reset() {
    this.currentTime = 0;
    this.nextId = 1;
    this.timers.clear();
  }
}

class PreviewRandom implements LowerBoardSimulationRandom {
  private index = 0;

  next() {
    const value = previewRandomSequence[this.index % previewRandomSequence.length] ?? 0.8;
    this.index += 1;
    return value;
  }

  reset() {
    this.index = 0;
  }
}

class PreviewTransport implements LowerBoardSimulationTransport {
  private handlers: LowerBoardSimulationTransportHandlers | null = null;

  async open(
    _options: Parameters<LowerBoardSimulationTransport["open"]>[0],
    handlers: LowerBoardSimulationTransportHandlers
  ) {
    if (this.handlers) {
      throw new Error("预览下板模拟传输已打开");
    }
    this.handlers = handlers;
  }

  async write(_data: Uint8Array) {}

  async close() {
    this.handlers = null;
  }

  receive(data: Uint8Array) {
    this.handlers?.onData(Uint8Array.from(data));
  }
}

export type PreviewLowerBoardSimHarnessOptions = {
  autoInput?: boolean;
};

export function createPreviewLowerBoardSimHarness(options: PreviewLowerBoardSimHarnessOptions = {}) {
  const clock = new PreviewClock();
  const random = new PreviewRandom();
  const transport = new PreviewTransport();
  let storedConfig = { ...previewLowerBoardSimConfig };
  let commandIndex = 0;
  let responseDelayMs = storedConfig.responseDelayMs;
  let running = false;
  let intervalHandle: unknown;

  const session = createLowerBoardSimulationSession({
    clock,
    random,
    transport,
    storage: {
      load: async () => ({ ...storedConfig }),
      save: async (config) => {
        storedConfig = { ...config };
      }
    }
  });

  async function settleSessionEvents() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function emitNextCommand() {
    if (!running) {
      return;
    }

    clock.advanceBy(previewCommandIntervalMs);
    const frame = previewCommandFrames[commandIndex % previewCommandFrames.length];
    commandIndex += 1;
    transport.receive(frame ?? previewCommandFrames[0]);
    clock.advanceBy(responseDelayMs);
    await settleSessionEvents();
  }

  const adapter: AkiApi["lowerBoardSim"] = {
    getConfig: async () => ({ config: await session.loadConfig(), configPath: previewConfigPath }),
    saveConfig: async (config) => ({ config: await session.saveConfig(config), configPath: previewConfigPath }),
    listPorts: async () => [
      { path: "COM9", manufacturer: "AKI lower-board simulator preview" },
      { path: "COM10", manufacturer: "USB-TTL preview adapter" }
    ],
    start: async (config) => {
      if (!running) {
        clock.reset();
        random.reset();
        commandIndex = 0;
      }
      const status = await session.start(config);
      running = true;
      responseDelayMs = status.config.responseDelayMs;
      if (options.autoInput) {
        intervalHandle = globalThis.setInterval(() => {
          void emitNextCommand();
        }, previewCommandIntervalMs);
      }
      return status;
    },
    stop: async () => {
      if (intervalHandle !== undefined) {
        globalThis.clearInterval(intervalHandle as ReturnType<typeof setInterval>);
        intervalHandle = undefined;
      }
      const status = await session.stop();
      running = false;
      return status;
    },
    updateConfig: async (config) => {
      const status = await session.applyConfig(config);
      responseDelayMs = status.config.responseDelayMs;
      return status;
    },
    resetStats: async () => session.resetStats(),
    onStatus: (callback) => session.onStatus(callback),
    onFrame: (callback) => session.onFrame(callback)
  };

  return {
    adapter,
    receive: (data: Uint8Array) => transport.receive(data),
    advanceBy: (milliseconds: number) => clock.advanceBy(milliseconds),
    emitNextCommand,
    flush: settleSessionEvents
  };
}
