import type {
  LowerBoardSimCommandFrame,
  LowerBoardSimConfig,
  LowerBoardSimFrameEvent,
  LowerBoardSimStats,
  LowerBoardSimStatusEvent,
  LowerBoardSimStatusFrame,
  SerialConnectionStatus
} from "./lowerBoardSimulationContract.cjs";

export type {
  LowerBoardSimAdapter,
  LowerBoardSimCommandFrame,
  LowerBoardSimConfig,
  LowerBoardSimFrameEvent,
  LowerBoardSimPortInfo,
  LowerBoardSimStats,
  LowerBoardSimStatusEvent,
  LowerBoardSimStatusFrame,
  SerialConnectionStatus
} from "./lowerBoardSimulationContract.cjs";

export type LowerBoardSimulationTransportHandlers = {
  onData: (data: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: (error?: Error) => void;
};

export type LowerBoardSimulationTransport = {
  open: (
    options: {
      port: string;
      baudRate: 4800;
      dataBits: 8;
      parity: "none";
      stopBits: 1;
    },
    handlers: LowerBoardSimulationTransportHandlers
  ) => Promise<void>;
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
};

export type LowerBoardSimulationClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type LowerBoardSimulationRandom = {
  next: () => number;
};

export type LowerBoardSimulationStorage = {
  load: () => Promise<Partial<LowerBoardSimConfig> | null>;
  save: (config: LowerBoardSimConfig) => Promise<void>;
};

export type LowerBoardSimulationDependencies = {
  transport: LowerBoardSimulationTransport;
  clock: LowerBoardSimulationClock;
  random: LowerBoardSimulationRandom;
  storage: LowerBoardSimulationStorage;
};

export type LowerBoardSimulationSession = {
  loadConfig: () => Promise<LowerBoardSimConfig>;
  saveConfig: (config: Partial<LowerBoardSimConfig>) => Promise<LowerBoardSimConfig>;
  start: (config: Partial<LowerBoardSimConfig>) => Promise<LowerBoardSimStatusEvent>;
  applyConfig: (config: Partial<LowerBoardSimConfig>) => Promise<LowerBoardSimStatusEvent>;
  stop: () => Promise<LowerBoardSimStatusEvent>;
  resetStats: () => LowerBoardSimStatusEvent;
  onStatus: (listener: (event: LowerBoardSimStatusEvent) => void) => () => void;
  onFrame: (listener: (event: LowerBoardSimFrameEvent) => void) => () => void;
};

export const defaultLowerBoardSimConfig: LowerBoardSimConfig = {
  port: "",
  deviceType: 0x02,
  busVoltageV: 230,
  boardTemperatureC: 25,
  faultCode: 0,
  speedRampRpmPerSecond: 1200,
  responseDelayMs: 10,
  offlineMode: false,
  dropRatePercent: 0,
  badChecksumRatePercent: 0
};

const protocol = {
  baudRate: 4800 as const,
  commandFrameSize: 9,
  statusFrameSize: 15,
  header1: 0x5a,
  header2: 0xa5,
  temperatureOffset: 40,
  minSpeedRpm: 500,
  maxSpeedRpm: 4000
};

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.min(max, Math.max(min, numericValue)) : fallback;
}

function sanitizeConfig(
  input: Partial<LowerBoardSimConfig> | null | undefined,
  base: LowerBoardSimConfig = defaultLowerBoardSimConfig
): LowerBoardSimConfig {
  const merged = { ...base, ...(input ?? {}) };
  const rawPort = String(merged.port || "").trim().toUpperCase();

  return {
    port: rawPort === "AUTO" ? "" : rawPort,
    deviceType: Math.round(clampNumber(merged.deviceType, 1, 9, defaultLowerBoardSimConfig.deviceType)),
    busVoltageV: Math.round(clampNumber(merged.busVoltageV, 0, 65535, defaultLowerBoardSimConfig.busVoltageV)),
    boardTemperatureC: Math.round(
      clampNumber(merged.boardTemperatureC, -40, 215, defaultLowerBoardSimConfig.boardTemperatureC)
    ),
    faultCode: Math.round(clampNumber(merged.faultCode, 0, 65535, defaultLowerBoardSimConfig.faultCode)),
    speedRampRpmPerSecond: Math.round(
      clampNumber(merged.speedRampRpmPerSecond, 1, 10000, defaultLowerBoardSimConfig.speedRampRpmPerSecond)
    ),
    responseDelayMs: Math.round(
      clampNumber(merged.responseDelayMs, 0, 5000, defaultLowerBoardSimConfig.responseDelayMs)
    ),
    offlineMode: Boolean(merged.offlineMode),
    dropRatePercent: clampNumber(merged.dropRatePercent, 0, 100, defaultLowerBoardSimConfig.dropRatePercent),
    badChecksumRatePercent: clampNumber(
      merged.badChecksumRatePercent,
      0,
      100,
      defaultLowerBoardSimConfig.badChecksumRatePercent
    )
  };
}

function emptyStats(): LowerBoardSimStats {
  return {
    rxBytes: 0,
    txBytes: 0,
    commandFrames: 0,
    statusFrames: 0,
    crcErrors: 0,
    syncErrors: 0,
    droppedResponses: 0,
    badChecksumResponses: 0,
    faultClearPulses: 0
  };
}

function isSessionBusy(status: SerialConnectionStatus) {
  return status === "opening" || status === "open" || status === "closing";
}

function xor8(data: Uint8Array, length: number) {
  let checksum = 0;

  for (let index = 0; index < length; index += 1) {
    checksum ^= data[index] ?? 0;
  }

  return checksum & 0xff;
}

function bytesToHex(data: Uint8Array) {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function readU16(frame: Uint8Array, highIndex: number) {
  return ((frame[highIndex] ?? 0) << 8) | (frame[highIndex + 1] ?? 0);
}

function writeU16(frame: Uint8Array, highIndex: number, value: number) {
  const sanitized = Math.round(clampNumber(value, 0, 65535, 0));
  frame[highIndex] = (sanitized >> 8) & 0xff;
  frame[highIndex + 1] = sanitized & 0xff;
}

function decodeCommand(frame: Uint8Array): LowerBoardSimCommandFrame {
  return {
    deviceType: frame[2] ?? 0,
    run: (frame[3] ?? 0) !== 0,
    targetSpeedRpm: readU16(frame, 4),
    faultClear: (frame[6] ?? 0) !== 0,
    reserved: frame[7] ?? 0
  };
}

function encodeStatus(status: LowerBoardSimStatusFrame, corruptChecksum: boolean) {
  const frame = new Uint8Array(protocol.statusFrameSize);
  frame[0] = protocol.header1;
  frame[1] = protocol.header2;
  frame[2] = status.deviceType & 0xff;
  writeU16(frame, 3, status.currentSpeedRpm);
  writeU16(frame, 5, status.busVoltageV);
  writeU16(frame, 7, status.busCurrentMa);
  writeU16(frame, 9, status.motorPowerW);
  frame[11] = Math.round(
    clampNumber(status.boardTemperatureC + protocol.temperatureOffset, 0, 255, protocol.temperatureOffset)
  );
  writeU16(frame, 12, status.faultCode);
  frame[14] = xor8(frame, 14);

  if (corruptChecksum) {
    frame[14] ^= 0x01;
  }

  return frame;
}

export function createLowerBoardSimulationSession(
  dependencies: LowerBoardSimulationDependencies
): LowerBoardSimulationSession {
  const statusListeners = new Set<(event: LowerBoardSimStatusEvent) => void>();
  const frameListeners = new Set<(event: LowerBoardSimFrameEvent) => void>();
  let connectionStatus: SerialConnectionStatus = "closed";
  let savedConfig = { ...defaultLowerBoardSimConfig };
  let activeConfig = { ...defaultLowerBoardSimConfig };
  let stats = emptyStats();
  let currentSpeedRpm = 0;
  let lastSpeedUpdateAt = dependencies.clock.now();
  let inputBuffer = new Uint8Array();
  let terminalErrorMessage: string | undefined;
  const pendingTimers = new Set<unknown>();

  function cloneStats(): LowerBoardSimStats {
    return {
      ...stats,
      lastCommand: stats.lastCommand ? { ...stats.lastCommand } : undefined,
      lastStatus: stats.lastStatus ? { ...stats.lastStatus } : undefined
    };
  }

  function makeStatus(message: string): LowerBoardSimStatusEvent {
    return {
      status: connectionStatus,
      running: connectionStatus === "open",
      message,
      port: activeConfig.port,
      config: { ...activeConfig },
      stats: cloneStats(),
      timestamp: dependencies.clock.now()
    };
  }

  function emitStatus(message: string) {
    const event = makeStatus(message);
    statusListeners.forEach((listener) => listener(event));
    return event;
  }

  function emitFrame(event: Omit<LowerBoardSimFrameEvent, "timestamp">) {
    const payload = { ...event, timestamp: dependencies.clock.now() };
    frameListeners.forEach((listener) => listener(payload));
  }

  function clearPendingTimers() {
    pendingTimers.forEach((timer) => dependencies.clock.clearTimeout(timer));
    pendingTimers.clear();
  }

  async function terminateWithError(message: string) {
    terminalErrorMessage = message;
    clearPendingTimers();
    inputBuffer = new Uint8Array();
    connectionStatus = "error";
    emitStatus(message);
    try {
      await dependencies.transport.close();
    } catch {
    }
  }

  function advanceSpeed(command: LowerBoardSimCommandFrame, config: LowerBoardSimConfig) {
    const now = dependencies.clock.now();
    const elapsedSeconds = Math.max(0, (now - lastSpeedUpdateAt) / 1000);
    const targetSpeedRpm = command.run
      ? Math.round(clampNumber(command.targetSpeedRpm, protocol.minSpeedRpm, protocol.maxSpeedRpm, protocol.minSpeedRpm))
      : 0;
    const maxStep = config.speedRampRpmPerSecond * elapsedSeconds;
    const delta = targetSpeedRpm - currentSpeedRpm;

    currentSpeedRpm = Math.abs(delta) <= maxStep ? targetSpeedRpm : currentSpeedRpm + Math.sign(delta) * maxStep;
    currentSpeedRpm = Math.round(clampNumber(currentSpeedRpm, 0, protocol.maxSpeedRpm, 0));
    lastSpeedUpdateAt = now;
  }

  function buildStatus(command: LowerBoardSimCommandFrame, config: LowerBoardSimConfig): LowerBoardSimStatusFrame {
    advanceSpeed(command, config);
    const speedRatio = currentSpeedRpm / protocol.maxSpeedRpm;
    const busCurrentMa = currentSpeedRpm > 0 ? Math.round(500 + speedRatio * 3500) : 0;
    const motorPowerW = currentSpeedRpm > 0 ? Math.round((config.busVoltageV * busCurrentMa) / 1000) : 0;

    return {
      deviceType: config.deviceType,
      currentSpeedRpm,
      busVoltageV: config.busVoltageV,
      busCurrentMa,
      motorPowerW,
      boardTemperatureC: config.boardTemperatureC,
      faultCode: config.faultCode
    };
  }

  function handleCommandFrame(frame: Uint8Array) {
    if (frame[8] !== xor8(frame, 8)) {
      stats.crcErrors += 1;
      emitFrame({
        direction: "rx",
        frameType: "error",
        hex: bytesToHex(frame),
        message: "命令帧 XOR8 校验失败"
      });
      return;
    }

    const command = decodeCommand(frame);
    if (command.deviceType < 1 || command.deviceType > 9) {
      stats.syncErrors += 1;
      emitFrame({
        direction: "rx",
        frameType: "error",
        hex: bytesToHex(frame),
        message: `未知设备类型: 0x${command.deviceType.toString(16).padStart(2, "0").toUpperCase()}`
      });
      return;
    }

    stats.commandFrames += 1;
    stats.lastCommand = command;
    emitFrame({
      direction: "rx",
      frameType: "command",
      hex: bytesToHex(frame),
      message: `命令 run=${command.run ? "1" : "0"} speed=${command.targetSpeedRpm} faultClear=${command.faultClear ? "1" : "0"}`,
      command
    });

    if (command.faultClear) {
      stats.faultClearPulses += 1;
      activeConfig = { ...activeConfig, faultCode: 0 };
      const nextSavedConfig = { ...savedConfig, faultCode: 0 };
      void dependencies.storage.save(nextSavedConfig).then(
        () => {
          savedConfig = nextSavedConfig;
        },
        async (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          await terminateWithError(`下板模拟配置保存失败: ${detail}`);
        }
      );
    }

    const configSnapshot = { ...activeConfig };
    const statusSnapshot = buildStatus(command, configSnapshot);
    const shouldDrop =
      configSnapshot.offlineMode || dependencies.random.next() * 100 < configSnapshot.dropRatePercent;

    if (shouldDrop) {
      stats.droppedResponses += 1;
      emitFrame({
        direction: "tx",
        frameType: "error",
        hex: "",
        message: configSnapshot.offlineMode ? "离线模式: 已抑制回包" : "丢包注入: 已抑制回包"
      });
      emitStatus("已接收命令但未回包");
      return;
    }

    const corruptChecksum = dependencies.random.next() * 100 < configSnapshot.badChecksumRatePercent;

    const timer = dependencies.clock.setTimeout(() => {
      pendingTimers.delete(timer);
      if (connectionStatus !== "open") {
        return;
      }
      const response = encodeStatus(statusSnapshot, corruptChecksum);
      void dependencies.transport.write(response).then(
        () => {
          if (connectionStatus !== "open") {
            return;
          }
          stats.txBytes += response.length;
          stats.statusFrames += 1;
          stats.lastStatus = statusSnapshot;
          if (corruptChecksum) {
            stats.badChecksumResponses += 1;
          }
          emitFrame({
            direction: "tx",
            frameType: "status",
            hex: bytesToHex(response),
            message: corruptChecksum ? "已发送坏校验状态帧" : "已发送状态帧",
            statusFrame: statusSnapshot
          });
          emitStatus("下板模拟运行中");
        },
        (error: unknown) => {
          if (connectionStatus !== "open") {
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          const message = `下板模拟串口写入失败: ${detail}`;
          emitFrame({
            direction: "tx",
            frameType: "error",
            hex: bytesToHex(response),
            message
          });
          void terminateWithError(message);
        }
      );
    }, configSnapshot.responseDelayMs);
    pendingTimers.add(timer);
  }

  function handleData(data: Uint8Array) {
    if (connectionStatus !== "open") {
      return;
    }

    stats.rxBytes += data.length;
    const combined = new Uint8Array(inputBuffer.length + data.length);
    combined.set(inputBuffer);
    combined.set(data, inputBuffer.length);
    inputBuffer = combined;

    for (;;) {
      if (inputBuffer.length === 0) {
        return;
      }

      if (inputBuffer[0] !== protocol.header1) {
        const skipped = inputBuffer.subarray(0, 1);
        inputBuffer = inputBuffer.subarray(1);
        stats.syncErrors += 1;
        emitFrame({
          direction: "rx",
          frameType: "error",
          hex: bytesToHex(skipped),
          message: "同步失败: 丢弃非帧头字节"
        });
        continue;
      }

      if (inputBuffer.length < 2) {
        return;
      }

      if (inputBuffer[1] !== protocol.header2) {
        const skipped = inputBuffer.subarray(0, 2);
        inputBuffer = inputBuffer.subarray(1);
        stats.syncErrors += 1;
        emitFrame({
          direction: "rx",
          frameType: "error",
          hex: bytesToHex(skipped),
          message: "同步失败: 帧头第二字节不匹配"
        });
        continue;
      }

      if (inputBuffer.length < protocol.commandFrameSize) {
        return;
      }

      const frame = Uint8Array.from(inputBuffer.subarray(0, protocol.commandFrameSize));
      inputBuffer = inputBuffer.subarray(protocol.commandFrameSize);
      handleCommandFrame(frame);
    }
  }

  async function loadConfig() {
    savedConfig = sanitizeConfig(await dependencies.storage.load());
    return { ...savedConfig };
  }

  async function saveConfig(config: Partial<LowerBoardSimConfig>) {
    if (isSessionBusy(connectionStatus)) {
      throw new Error("下板模拟运行中，请使用应用配置");
    }

    const nextConfig = sanitizeConfig(config, savedConfig);
    await dependencies.storage.save(nextConfig);
    savedConfig = nextConfig;
    return { ...savedConfig };
  }

  async function start(config: Partial<LowerBoardSimConfig>) {
    if (isSessionBusy(connectionStatus)) {
      throw new Error("下板模拟已在启动或运行");
    }

    const nextConfig = sanitizeConfig(config, savedConfig);
    let startupAbortError: Error | undefined;
    terminalErrorMessage = undefined;
    connectionStatus = "opening";
    activeConfig = nextConfig;
    emitStatus(`正在打开 ${nextConfig.port}`);
    try {
      await dependencies.transport.open(
        {
          port: nextConfig.port,
          baudRate: protocol.baudRate,
          dataBits: 8,
          parity: "none",
          stopBits: 1
        },
        {
          onData: handleData,
          onError: (error) => {
            if (connectionStatus === "opening") {
              startupAbortError = error;
            }
            void terminateWithError(`下板模拟串口错误: ${error.message}`);
          },
          onClose: (error) => {
            clearPendingTimers();
            inputBuffer = new Uint8Array();
            if (connectionStatus === "opening") {
              startupAbortError = error ?? new Error("串口在启动期间关闭");
            }
            if (error) {
              terminalErrorMessage = `下板模拟已断开: ${error.message}`;
            }
            connectionStatus = terminalErrorMessage ? "error" : "closed";
            emitStatus(terminalErrorMessage ?? "下板模拟已停止");
          }
        }
      );
      await dependencies.storage.save(nextConfig);
      if (startupAbortError) {
        throw startupAbortError;
      }
      if (connectionStatus !== "opening") {
        throw new Error("串口在启动期间关闭");
      }
    } catch (error) {
      clearPendingTimers();
      inputBuffer = new Uint8Array();
      try {
        await dependencies.transport.close();
      } catch {
      }
      activeConfig = { ...savedConfig };
      connectionStatus = "error";
      const message = error instanceof Error ? error.message : String(error);
      emitStatus(`下板模拟启动失败: ${message}`);
      throw error;
    }
    savedConfig = { ...nextConfig };
    activeConfig = { ...nextConfig };
    stats = emptyStats();
    currentSpeedRpm = 0;
    lastSpeedUpdateAt = dependencies.clock.now();
    inputBuffer = new Uint8Array();
    connectionStatus = "open";
    return emitStatus(`下板模拟已启动 ${nextConfig.port} / 4800 8N1`);
  }

  async function applyConfig(config: Partial<LowerBoardSimConfig>) {
    if (connectionStatus !== "open") {
      throw new Error("下板模拟未运行");
    }

    const nextConfig = sanitizeConfig(config, activeConfig);
    if (nextConfig.port !== activeConfig.port) {
      throw new Error("运行中不能更换下板模拟串口");
    }

    await dependencies.storage.save(nextConfig);
    savedConfig = { ...nextConfig };
    activeConfig = { ...nextConfig };
    return emitStatus("下板模拟配置已应用");
  }

  function resetStats() {
    stats = emptyStats();
    return emitStatus("下板模拟统计已复位");
  }

  async function stop() {
    if (connectionStatus === "closed") {
      return emitStatus("下板模拟未运行");
    }

    connectionStatus = "closing";
    terminalErrorMessage = undefined;
    emitStatus("正在停止下板模拟");
    clearPendingTimers();
    inputBuffer = new Uint8Array();
    await dependencies.transport.close();
    connectionStatus = "closed";
    return emitStatus("下板模拟已停止");
  }

  return {
    loadConfig,
    saveConfig,
    start,
    applyConfig,
    stop,
    resetStats,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    }
  };
}
