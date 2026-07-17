import assert from "node:assert/strict";
import test from "node:test";
import {
  createLowerBoardSimulationSession,
  defaultLowerBoardSimConfig,
  type LowerBoardSimConfig,
  type LowerBoardSimFrameEvent,
  type LowerBoardSimStatusEvent,
  type LowerBoardSimulationClock,
  type LowerBoardSimulationStorage,
  type LowerBoardSimulationTransport,
  type LowerBoardSimulationTransportHandlers
} from "../shared/lowerBoardSimulation.ts";
import { defineLowerBoardSimAdapterContract } from "./lowerBoardSimAdapterContract.ts";

class TestClock implements LowerBoardSimulationClock {
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
    const targetTime = this.currentTime + milliseconds;

    for (;;) {
      const nextTimer = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.at <= targetTime)
        .sort((left, right) => left[1].at - right[1].at)[0];

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
}

class TestTransport implements LowerBoardSimulationTransport {
  private handlers: LowerBoardSimulationTransportHandlers | null = null;
  private opened = false;
  emitCloseOnClose = false;
  failNextWrite = false;

  async open(_options: Parameters<LowerBoardSimulationTransport["open"]>[0], handlers: LowerBoardSimulationTransportHandlers) {
    if (this.opened) {
      throw new Error("测试串口已打开");
    }
    this.opened = true;
    this.handlers = handlers;
  }

  async write(_data: Uint8Array) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("测试写入失败");
    }
  }

  async close() {
    const handlers = this.handlers;
    this.opened = false;
    this.handlers = null;
    if (this.emitCloseOnClose) {
      handlers?.onClose();
    }
  }

  receive(data: Uint8Array) {
    this.handlers?.onData(data);
  }

  disconnect(error: Error) {
    const handlers = this.handlers;
    this.opened = false;
    this.handlers = null;
    handlers?.onClose(error);
  }

  fail(error: Error) {
    this.handlers?.onError(error);
  }
}

class TestStorage implements LowerBoardSimulationStorage {
  saved: LowerBoardSimConfig | null = null;
  failNextSave = false;
  holdNextSave = false;
  private releasePendingSave: (() => void) | null = null;

  async load() {
    return this.saved;
  }

  async save(config: LowerBoardSimConfig) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("测试保存失败");
    }
    if (this.holdNextSave) {
      this.holdNextSave = false;
      await new Promise<void>((resolve) => {
        this.releasePendingSave = () => {
          this.saved = { ...config };
          this.releasePendingSave = null;
          resolve();
        };
      });
      return;
    }
    this.saved = { ...config };
  }

  releaseSave() {
    this.releasePendingSave?.();
  }
}

function createTestFixture(randomNext: () => number = () => 0.5) {
  const clock = new TestClock();
  const transport = new TestTransport();
  const storage = new TestStorage();
  const session = createLowerBoardSimulationSession({
    clock,
    transport,
    storage,
    random: { next: randomNext }
  });

  return { clock, transport, storage, session };
}

test("下板模拟会话在延迟后生成 Electron 黄金状态帧", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onFrame((event) => frames.push(event));

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  clock.advanceBy(1000);
  transport.receive(Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x05, 0xdc, 0x00, 0x00, 0x25]));
  clock.advanceBy(10);
  await Promise.resolve();

  assert.equal(frames.find((event) => event.direction === "tx")?.hex, "5A A5 02 04 BC 00 E6 06 19 01 67 41 00 00 9B");
});

test("下板模拟会话用可控时钟覆盖速度边界目标变化和停止降速", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onFrame((event) => frames.push(event));

  const exchange = async (elapsedMs: number, command: number[]) => {
    clock.advanceBy(elapsedMs);
    transport.receive(Uint8Array.from(command));
    clock.advanceBy(0);
    await Promise.resolve();
  };

  await session.start({
    ...defaultLowerBoardSimConfig,
    port: "COM9",
    speedRampRpmPerSecond: 1000,
    responseDelayMs: 0
  });
  await exchange(1000, [0x5a, 0xa5, 0x02, 0x01, 0x00, 0x64, 0x00, 0x00, 0x98]);
  await exchange(4000, [0x5a, 0xa5, 0x02, 0x01, 0x13, 0x88, 0x00, 0x00, 0x67]);
  await exchange(1000, [0x5a, 0xa5, 0x02, 0x01, 0x07, 0xd0, 0x00, 0x00, 0x2b]);
  await exchange(1000, [0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);
  await exchange(2000, [0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);

  assert.deepEqual(
    frames
      .filter((event) => event.direction === "tx" && event.frameType === "status")
      .map((event) => event.statusFrame?.currentSpeedRpm),
    [500, 4000, 3000, 2000, 0]
  );
});

test("下板模拟会话接受设备类型边界并拒绝范围外类型", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onFrame((event) => frames.push(event));

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 0 });
  transport.receive(
    Uint8Array.from([
      0x5a, 0xa5, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
      0x5a, 0xa5, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfe,
      0x5a, 0xa5, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf6,
      0x5a, 0xa5, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf5
    ])
  );
  clock.advanceBy(0);
  await Promise.resolve();

  assert.deepEqual(
    frames
      .filter((event) => event.direction === "rx")
      .map((event) => ({ type: event.frameType, deviceType: event.command?.deviceType, message: event.message })),
    [
      { type: "error", deviceType: undefined, message: "未知设备类型: 0x00" },
      { type: "command", deviceType: 1, message: "命令 run=0 speed=0 faultClear=0" },
      { type: "command", deviceType: 9, message: "命令 run=0 speed=0 faultClear=0" },
      { type: "error", deviceType: undefined, message: "未知设备类型: 0x0A" }
    ]
  );
});

test("下板模拟会话从噪声和任意分片中恢复连续命令", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onFrame((event) => frames.push(event));
  session.onStatus((event) => statuses.push(event));
  const stoppedCommand = Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  transport.receive(Uint8Array.from([0x00, 0x5a, 0x00]));
  transport.receive(stoppedCommand.subarray(0, 1));
  transport.receive(stoppedCommand.subarray(1, 4));
  transport.receive(Uint8Array.from([...stoppedCommand.subarray(4), ...stoppedCommand]));
  clock.advanceBy(10);
  await Promise.resolve();

  const finalStats = statuses.at(-1)?.stats;
  assert.deepEqual(
    {
      txFrames: frames.filter((event) => event.direction === "tx").map((event) => event.hex),
      errorMessages: frames.filter((event) => event.frameType === "error").map((event) => event.message),
      stats: finalStats
        ? {
            rxBytes: finalStats.rxBytes,
            commandFrames: finalStats.commandFrames,
            statusFrames: finalStats.statusFrames,
            syncErrors: finalStats.syncErrors
          }
        : null
    },
    {
      txFrames: [
        "5A A5 02 00 00 00 E6 00 00 00 00 41 00 00 5A",
        "5A A5 02 00 00 00 E6 00 00 00 00 41 00 00 5A"
      ],
      errorMessages: [
        "同步失败: 丢弃非帧头字节",
        "同步失败: 帧头第二字节不匹配",
        "同步失败: 丢弃非帧头字节"
      ],
      stats: {
        rxBytes: 21,
        commandFrames: 2,
        statusFrames: 2,
        syncErrors: 3
      }
    }
  );
});

test("下板模拟会话拒绝坏校验和未知设备后继续处理有效命令", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onFrame((event) => frames.push(event));
  session.onStatus((event) => statuses.push(event));

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  transport.receive(
    Uint8Array.from([
      0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfc,
      0x5a, 0xa5, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf5,
      0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd
    ])
  );
  clock.advanceBy(10);
  await Promise.resolve();

  const finalStats = statuses.at(-1)?.stats;
  assert.deepEqual(
    {
      txFrames: frames.filter((event) => event.direction === "tx").map((event) => event.hex),
      errorMessages: frames.filter((event) => event.frameType === "error").map((event) => event.message),
      stats: finalStats
        ? {
            commandFrames: finalStats.commandFrames,
            statusFrames: finalStats.statusFrames,
            crcErrors: finalStats.crcErrors,
            syncErrors: finalStats.syncErrors
          }
        : null
    },
    {
      txFrames: ["5A A5 02 00 00 00 E6 00 00 00 00 41 00 00 5A"],
      errorMessages: ["命令帧 XOR8 校验失败", "未知设备类型: 0x0A"],
      stats: {
        commandFrames: 1,
        statusFrames: 1,
        crcErrors: 1,
        syncErrors: 1
      }
    }
  );
});

test("下板模拟会话使用固定随机序列重放丢包和坏校验", async () => {
  const randomValues = [0.2, 0.8, 0.2, 0.8, 0.8];
  const { clock, transport, session } = createTestFixture(() => randomValues.shift() ?? 0.8);
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onFrame((event) => frames.push(event));
  session.onStatus((event) => statuses.push(event));
  const stoppedCommand = Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);

  await session.start({
    ...defaultLowerBoardSimConfig,
    port: "COM9",
    responseDelayMs: 0,
    dropRatePercent: 50,
    badChecksumRatePercent: 50
  });
  transport.receive(Uint8Array.from([...stoppedCommand, ...stoppedCommand, ...stoppedCommand]));
  clock.advanceBy(0);
  await Promise.resolve();

  const finalStats = statuses.at(-1)?.stats;
  assert.deepEqual(
    {
      outputs: frames
        .filter((event) => event.direction === "tx")
        .map((event) => ({ type: event.frameType, hex: event.hex, message: event.message })),
      stats: finalStats
        ? {
            commandFrames: finalStats.commandFrames,
            statusFrames: finalStats.statusFrames,
            droppedResponses: finalStats.droppedResponses,
            badChecksumResponses: finalStats.badChecksumResponses
          }
        : null
    },
    {
      outputs: [
        { type: "error", hex: "", message: "丢包注入: 已抑制回包" },
        {
          type: "status",
          hex: "5A A5 02 00 00 00 E6 00 00 00 00 41 00 00 5B",
          message: "已发送坏校验状态帧"
        },
        {
          type: "status",
          hex: "5A A5 02 00 00 00 E6 00 00 00 00 41 00 00 5A",
          message: "已发送状态帧"
        }
      ],
      stats: {
        commandFrames: 3,
        statusFrames: 2,
        droppedResponses: 1,
        badChecksumResponses: 1
      }
    }
  );
});

test("下板模拟会话覆盖离线及百分比零值和满值边界", async () => {
  const { clock, transport, session } = createTestFixture(() => 0.999);
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onFrame((event) => frames.push(event));
  session.onStatus((event) => statuses.push(event));
  const command = Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);
  const config = { ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 0 };

  await session.start(config);
  transport.receive(command);
  clock.advanceBy(0);
  await Promise.resolve();
  await session.applyConfig({ ...config, dropRatePercent: 100 });
  transport.receive(command);
  await session.applyConfig({ ...config, offlineMode: true });
  transport.receive(command);
  await session.applyConfig({ ...config, badChecksumRatePercent: 100 });
  transport.receive(command);
  clock.advanceBy(0);
  await Promise.resolve();

  assert.deepEqual(
    {
      outputs: frames.filter((event) => event.direction === "tx").map((event) => event.message),
      stats: {
        droppedResponses: statuses.at(-1)?.stats.droppedResponses,
        statusFrames: statuses.at(-1)?.stats.statusFrames,
        badChecksumResponses: statuses.at(-1)?.stats.badChecksumResponses
      }
    },
    {
      outputs: ["已发送状态帧", "丢包注入: 已抑制回包", "离线模式: 已抑制回包", "已发送坏校验状态帧"],
      stats: { droppedResponses: 2, statusFrames: 2, badChecksumResponses: 1 }
    }
  );
});

test("下板模拟会话让已排队响应保留命令接收时配置", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onFrame((event) => frames.push(event));
  const stoppedCommand = Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 100 });
  transport.receive(stoppedCommand);
  await session.applyConfig({
    ...defaultLowerBoardSimConfig,
    port: "COM9",
    busVoltageV: 240,
    boardTemperatureC: 30,
    responseDelayMs: 0
  });
  clock.advanceBy(100);
  await Promise.resolve();
  transport.receive(stoppedCommand);
  clock.advanceBy(0);
  await Promise.resolve();

  assert.deepEqual(
    frames.filter((event) => event.direction === "tx").map((event) => event.hex),
    [
      "5A A5 02 00 00 00 E6 00 00 00 00 41 00 00 5A",
      "5A A5 02 00 00 00 F0 00 00 00 00 46 00 00 4B"
    ]
  );
});

test("下板模拟会话运行时拒绝保存或应用其他串口", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  let saveError = "";
  let applyError = "";

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  try {
    await session.saveConfig({ ...defaultLowerBoardSimConfig, port: "COM10" });
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }
  try {
    await session.applyConfig({ ...defaultLowerBoardSimConfig, port: "COM10" });
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error);
  }
  const savedConfig = await session.loadConfig();

  assert.deepEqual(
    { saveError, applyError, savedPort: savedConfig.port },
    {
      saveError: "下板模拟运行中，请使用应用配置",
      applyError: "运行中不能更换下板模拟串口",
      savedPort: "COM9"
    }
  );
});

test("下板模拟会话归一化配置并在应用保存失败时保持原状态", async () => {
  const { clock, transport, storage, session } = createTestFixture();

  const normalized = await session.saveConfig({
    ...defaultLowerBoardSimConfig,
    port: " auto ",
    deviceType: 99,
    busVoltageV: -1,
    boardTemperatureC: 999,
    faultCode: 99999,
    speedRampRpmPerSecond: 0,
    responseDelayMs: 99999,
    dropRatePercent: -1,
    badChecksumRatePercent: 101
  });
  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  storage.failNextSave = true;
  await assert.rejects(
    session.applyConfig({ ...defaultLowerBoardSimConfig, port: "COM9", busVoltageV: 400 }),
    /测试保存失败/
  );
  const afterFailure = session.resetStats();

  assert.deepEqual(normalized, {
    ...defaultLowerBoardSimConfig,
    port: "",
    deviceType: 9,
    busVoltageV: 0,
    boardTemperatureC: 215,
    faultCode: 65535,
    speedRampRpmPerSecond: 1,
    responseDelayMs: 5000,
    dropRatePercent: 0,
    badChecksumRatePercent: 100
  });
  assert.equal(afterFailure.config.busVoltageV, defaultLowerBoardSimConfig.busVoltageV);
  assert.equal(storage.saved?.busVoltageV, defaultLowerBoardSimConfig.busVoltageV);
});

test("下板模拟会话把 Partial 配置合并到对应的已保存或运行快照", async () => {
  const { storage, session } = createTestFixture();
  storage.saved = { ...defaultLowerBoardSimConfig, port: "COM9", faultCode: 7 };

  await session.loadConfig();
  const saved = await session.saveConfig({ busVoltageV: 400 });
  const started = await session.start({ boardTemperatureC: 33 });
  const applied = await session.applyConfig({ faultCode: 9 });

  assert.deepEqual(
    {
      saved: { port: saved.port, busVoltageV: saved.busVoltageV, faultCode: saved.faultCode },
      started: {
        port: started.config.port,
        busVoltageV: started.config.busVoltageV,
        boardTemperatureC: started.config.boardTemperatureC,
        faultCode: started.config.faultCode
      },
      applied: {
        port: applied.config.port,
        busVoltageV: applied.config.busVoltageV,
        boardTemperatureC: applied.config.boardTemperatureC,
        faultCode: applied.config.faultCode
      }
    },
    {
      saved: { port: "COM9", busVoltageV: 400, faultCode: 7 },
      started: { port: "COM9", busVoltageV: 400, boardTemperatureC: 33, faultCode: 7 },
      applied: { port: "COM9", busVoltageV: 400, boardTemperatureC: 33, faultCode: 9 }
    }
  );
});

test("下板模拟会话重置统计时保留排队响应半帧和运行状态", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onFrame((event) => frames.push(event));
  session.onStatus((event) => statuses.push(event));
  const runAndClearFault = Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x05, 0xdc, 0x01, 0x00, 0x24]);

  await session.start({
    ...defaultLowerBoardSimConfig,
    port: "COM9",
    faultCode: 0x1234,
    responseDelayMs: 50
  });
  clock.advanceBy(1000);
  transport.receive(runAndClearFault);
  transport.receive(runAndClearFault.subarray(0, 4));
  const resetStatus = session.resetStats();
  clock.advanceBy(50);
  await Promise.resolve();
  transport.receive(runAndClearFault.subarray(4));
  clock.advanceBy(50);
  await Promise.resolve();

  const finalStats = statuses.at(-1)?.stats;
  assert.deepEqual(
    {
      resetStats: resetStatus.stats,
      txFrames: frames.filter((event) => event.direction === "tx").map((event) => event.hex),
      finalStats: finalStats
        ? {
            commandFrames: finalStats.commandFrames,
            statusFrames: finalStats.statusFrames,
            faultClearPulses: finalStats.faultClearPulses,
            lastSpeed: finalStats.lastStatus?.currentSpeedRpm
          }
        : null
    },
    {
      resetStats: {
        rxBytes: 0,
        txBytes: 0,
        commandFrames: 0,
        statusFrames: 0,
        crcErrors: 0,
        syncErrors: 0,
        droppedResponses: 0,
        badChecksumResponses: 0,
        faultClearPulses: 0,
        lastCommand: undefined,
        lastStatus: undefined
      },
      txFrames: [
        "5A A5 02 04 EC 00 E6 06 43 01 71 41 00 00 87",
        "5A A5 02 05 28 00 E6 06 77 01 7D 41 00 00 7A"
      ],
      finalStats: {
        commandFrames: 1,
        statusFrames: 2,
        faultClearPulses: 1,
        lastSpeed: 1320
      }
    }
  );
});

test("下板模拟会话在故障清除持久化失败后释放资源并可重启", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const statuses: LowerBoardSimStatusEvent[] = [];
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onStatus((event) => statuses.push(event));
  session.onFrame((event) => frames.push(event));
  transport.emitCloseOnClose = true;

  await session.start({
    ...defaultLowerBoardSimConfig,
    port: "COM9",
    faultCode: 7,
    responseDelayMs: 100
  });
  storage.failNextSave = true;
  transport.receive(Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x05, 0xdc, 0x01, 0x00, 0x24]));
  await Promise.resolve();
  await Promise.resolve();
  clock.advanceBy(100);
  await Promise.resolve();
  const restarted = await session.start({ ...defaultLowerBoardSimConfig, port: "COM10" });

  assert.deepEqual(
    {
      failure: statuses.find((event) => event.message.includes("配置保存失败"))?.message,
      responsesBeforeRestart: frames.filter((event) => event.direction === "tx").length,
      restartStatus: restarted.status,
      restartPort: restarted.port
    },
    {
      failure: "下板模拟配置保存失败: 测试保存失败",
      responsesBeforeRestart: 0,
      restartStatus: "open",
      restartPort: "COM10"
    }
  );
});

test("下板模拟会话拒绝重复启动并允许幂等停止后立即重启", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onFrame((event) => frames.push(event));
  let repeatedStartError = "";
  const stoppedCommand = Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 100 });
  transport.receive(stoppedCommand);
  try {
    await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  } catch (error) {
    repeatedStartError = error instanceof Error ? error.message : String(error);
  }
  const firstStop = await session.stop();
  const secondStop = await session.stop();
  clock.advanceBy(100);
  await Promise.resolve();
  const restarted = await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });

  assert.deepEqual(
    {
      repeatedStartError,
      firstStop: firstStop.status,
      secondStop: secondStop.status,
      restarted: restarted.status,
      txFramesAfterStop: frames.filter((event) => event.direction === "tx").length
    },
    {
      repeatedStartError: "下板模拟已在启动或运行",
      firstStop: "closed",
      secondStop: "closed",
      restarted: "open",
      txFramesAfterStop: 0
    }
  );
});

test("下板模拟会话启动失败后回滚并允许立即重试", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  storage.failNextSave = true;
  let firstError = "";

  try {
    await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }
  const retried = await session.start({ ...defaultLowerBoardSimConfig, port: "COM10" });
  const savedConfig = await session.loadConfig();

  assert.deepEqual(
    { firstError, retryStatus: retried.status, retryPort: retried.port, savedPort: savedConfig.port },
    { firstError: "测试保存失败", retryStatus: "open", retryPort: "COM10", savedPort: "COM10" }
  );
});

test("下板模拟会话拒绝把启动期间已断开的串口报告为成功", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onStatus((event) => statuses.push(event));
  storage.holdNextSave = true;

  const starting = session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  await Promise.resolve();
  await Promise.resolve();
  transport.disconnect(new Error("USB 已断开"));
  storage.releaseSave();

  await assert.rejects(starting, /USB 已断开/);
  const restarted = await session.start({ ...defaultLowerBoardSimConfig, port: "COM10" });

  assert.deepEqual(
    {
      failedStatus: statuses.find((event) => event.message === "下板模拟启动失败: USB 已断开")?.status,
      restartStatus: restarted.status,
      restartPort: restarted.port
    },
    { failedStatus: "error", restartStatus: "open", restartPort: "COM10" }
  );
});

test("下板模拟会话异常断开后不会把旧响应发送到新会话", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onFrame((event) => frames.push(event));
  session.onStatus((event) => statuses.push(event));
  const stoppedCommand = Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]);

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 100 });
  transport.receive(stoppedCommand);
  transport.disconnect(new Error("USB 已断开"));
  const errorStatus = statuses.at(-1);
  const restarted = await session.start({ ...defaultLowerBoardSimConfig, port: "COM10" });
  clock.advanceBy(100);
  await Promise.resolve();

  assert.deepEqual(
    {
      error: errorStatus ? { status: errorStatus.status, running: errorStatus.running, message: errorStatus.message } : null,
      restarted: { status: restarted.status, port: restarted.port },
      txFrames: frames.filter((event) => event.direction === "tx").length
    },
    {
      error: { status: "error", running: false, message: "下板模拟已断开: USB 已断开" },
      restarted: { status: "open", port: "COM10" },
      txFrames: 0
    }
  );
});

test("下板模拟会话保留串口错误而不被随后关闭事件覆盖", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const statuses: LowerBoardSimStatusEvent[] = [];
  session.onStatus((event) => statuses.push(event));
  transport.emitCloseOnClose = true;

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9" });
  transport.fail(new Error("串口故障"));
  await Promise.resolve();

  assert.deepEqual(
    statuses.slice(-2).map((event) => ({ status: event.status, message: event.message })),
    [
      { status: "error", message: "下板模拟串口错误: 串口故障" },
      { status: "error", message: "下板模拟串口错误: 串口故障" }
    ]
  );
});

test("下板模拟会话把串口写入失败转为可观察错误并停止运行", async () => {
  const { clock, transport, storage, session } = createTestFixture();
  const statuses: LowerBoardSimStatusEvent[] = [];
  const frames: LowerBoardSimFrameEvent[] = [];
  session.onStatus((event) => statuses.push(event));
  session.onFrame((event) => frames.push(event));
  transport.failNextWrite = true;

  await session.start({ ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 0 });
  transport.receive(Uint8Array.from([0x5a, 0xa5, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd]));
  clock.advanceBy(0);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    {
      status: statuses.at(-1)?.status,
      running: statuses.at(-1)?.running,
      message: statuses.at(-1)?.message,
      frame: frames.at(-1)?.message,
      statusFrames: statuses.at(-1)?.stats.statusFrames
    },
    {
      status: "error",
      running: false,
      message: "下板模拟串口写入失败: 测试写入失败",
      frame: "下板模拟串口写入失败: 测试写入失败",
      statusFrames: 0
    }
  );
});

defineLowerBoardSimAdapterContract(() => {
  const { clock, transport, storage, session } = createTestFixture();
  const initialConfig = { ...defaultLowerBoardSimConfig, port: "COM9", responseDelayMs: 10 };
  storage.saved = { ...initialConfig };

  return {
    initialConfig,
    adapter: {
      getConfig: async () => ({ config: await session.loadConfig(), configPath: "测试配置" }),
      saveConfig: async (config) => ({ config: await session.saveConfig(config), configPath: "测试配置" }),
      listPorts: async () => [{ path: "COM9", manufacturer: "测试串口" }],
      start: (config) => session.start(config),
      stop: () => session.stop(),
      updateConfig: (config) => session.applyConfig(config),
      resetStats: async () => session.resetStats(),
      onStatus: (callback) => session.onStatus(callback),
      onFrame: (callback) => session.onFrame(callback)
    },
    receive: (data) => transport.receive(data),
    advanceBy: (milliseconds) => clock.advanceBy(milliseconds),
    flush: async () => Promise.resolve()
  };
});
