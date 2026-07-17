import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createElectronLowerBoardSimAdapter,
  createSerialPortLowerBoardSimulationTransport,
  type ElectronSerialPort,
  type ElectronSerialPortOpenOptions
} from "../electron/lowerBoardSimAdapter.ts";
import {
  createLowerBoardSimulationSession,
  defaultLowerBoardSimConfig,
  type LowerBoardSimConfig,
  type LowerBoardSimulationClock,
  type LowerBoardSimulationStorage,
  type LowerBoardSimulationTransport,
  type LowerBoardSimulationTransportHandlers
} from "../shared/lowerBoardSimulation.ts";
import { defineLowerBoardSimAdapterContract } from "./lowerBoardSimAdapterContract.ts";

class TestClock implements LowerBoardSimulationClock {
  private timestamp = 0;
  private nextHandle = 1;
  private timers = new Map<number, { callback: () => void; dueAt: number }>();

  now = () => this.timestamp;

  setTimeout = (callback: () => void, delayMs: number) => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, dueAt: this.timestamp + delayMs });
    return handle;
  };

  clearTimeout = (handle: unknown) => {
    this.timers.delete(Number(handle));
  };

  advanceBy(milliseconds: number) {
    this.timestamp += milliseconds;
    const dueTimers = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.timestamp)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);

    for (const [handle, timer] of dueTimers) {
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

class TestTransport implements LowerBoardSimulationTransport {
  handlers: LowerBoardSimulationTransportHandlers | undefined;
  writes: Uint8Array[] = [];

  async open(
    _options: Parameters<LowerBoardSimulationTransport["open"]>[0],
    handlers: LowerBoardSimulationTransportHandlers
  ) {
    this.handlers = handlers;
  }

  async write(data: Uint8Array) {
    this.writes.push(Uint8Array.from(data));
  }

  async close() {
    this.handlers = undefined;
  }

  receive(data: Uint8Array) {
    this.handlers?.onData(data);
  }
}

class TestStorage implements LowerBoardSimulationStorage {
  saved: LowerBoardSimConfig;

  constructor(saved: LowerBoardSimConfig) {
    this.saved = saved;
  }

  async load() {
    return { ...this.saved };
  }

  async save(config: LowerBoardSimConfig) {
    this.saved = { ...config };
  }
}

class TestSerialPort extends EventEmitter implements ElectronSerialPort {
  isOpen = false;
  writes: Uint8Array[] = [];

  open(callback: (error?: Error | null) => void) {
    this.isOpen = true;
    callback();
  }

  write(data: Uint8Array, callback: (error?: Error | null) => void) {
    this.writes.push(Uint8Array.from(data));
    callback();
  }

  drain(callback: (error?: Error | null) => void) {
    callback();
  }

  close(callback: (error?: Error | null) => void) {
    this.isOpen = false;
    callback();
    this.emit("close");
  }
}

defineLowerBoardSimAdapterContract(() => {
  const initialConfig = { ...defaultLowerBoardSimConfig, port: "COM9" };
  const clock = new TestClock();
  const transport = new TestTransport();
  const session = createLowerBoardSimulationSession({
    clock,
    transport,
    random: { next: () => 0.5 },
    storage: new TestStorage(initialConfig)
  });
  const adapter = createElectronLowerBoardSimAdapter({
    session,
    configPath: "C:\\AKI\\lower-board-sim.config.json",
    listPorts: async () => [{ path: "COM9", manufacturer: "测试串口" }]
  });

  return {
    adapter,
    initialConfig,
    receive: (data) => transport.receive(data),
    advanceBy: (milliseconds) => clock.advanceBy(milliseconds),
    flush: async () => Promise.resolve()
  };
});

test("Electron 串口输入经共享下板模拟会话处理后写回 4800 8N1 状态帧", async () => {
  const clock = new TestClock();
  const serialPort = new TestSerialPort();
  let openOptions: ElectronSerialPortOpenOptions | undefined;
  const transport = createSerialPortLowerBoardSimulationTransport({
    createPort: (options) => {
      openOptions = options;
      return serialPort;
    }
  });
  const session = createLowerBoardSimulationSession({
    clock,
    transport,
    random: { next: () => 0.5 },
    storage: new TestStorage({ ...defaultLowerBoardSimConfig, port: "COM9" })
  });
  const adapter = createElectronLowerBoardSimAdapter({
    session,
    configPath: "C:\\AKI\\lower-board-sim.config.json",
    listPorts: async () => [{ path: "COM9" }]
  });

  await adapter.start({ ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 10 });
  serialPort.emit("data", Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x05, 0xdc, 0x00, 0x00, 0x25]));
  clock.advanceBy(10);
  await Promise.resolve();

  assert.deepEqual(openOptions, {
    path: "COM9",
    baudRate: 4800,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    autoOpen: false
  });
  assert.equal(serialPort.writes.length, 1);
  assert.equal(serialPort.writes[0]?.length, 15);
  assert.deepEqual(Array.from(serialPort.writes[0]?.subarray(0, 3) ?? []), [0x5a, 0xa5, 0x02]);
});
