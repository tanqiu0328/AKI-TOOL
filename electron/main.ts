import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { SerialPort } from "serialport";

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

type SerialParity = "none" | "even" | "odd" | "mark" | "space";
type SerialTextEncoding = "utf-8" | "gbk";
type SerialDisplayMode = "text" | "hex";
type SerialConnectionStatus = "closed" | "opening" | "open" | "closing" | "reconnecting" | "error";
type SerialDataBits = 5 | 6 | 7 | 8;
type SerialStopBits = 1 | 1.5 | 2;

type SerialConfig = {
  port: string;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  textEncoding: SerialTextEncoding;
  receiveMode: SerialDisplayMode;
  sendMode: SerialDisplayMode;
  showTimestamp: boolean;
  frameGapMs: number;
  terminalMode: boolean;
  showSent: boolean;
  timedSend: boolean;
  timedSendIntervalMs: number;
  autoOpen: boolean;
  autoReconnect: boolean;
  dtr: boolean;
  rts: boolean;
};

type SerialLineSignals = {
  dtr: boolean;
  rts: boolean;
  cts: boolean | null;
  dsr: boolean | null;
  dcd: boolean | null;
};

type SerialStatusEvent = {
  status: SerialConnectionStatus;
  connected: boolean;
  message: string;
  port: string;
  signals: SerialLineSignals;
  timestamp: number;
};

type SerialWritePayload = {
  data: string;
  mode: SerialDisplayMode;
  encoding: SerialTextEncoding;
  appendLineEnding?: boolean;
};

type LowerBoardSimConfig = {
  port: string;
  deviceType: number;
  busVoltageV: number;
  boardTemperatureC: number;
  faultCode: number;
  speedRampRpmPerSecond: number;
  responseDelayMs: number;
  offlineMode: boolean;
  dropRatePercent: number;
  badChecksumRatePercent: number;
};

type LowerBoardSimCommandFrame = {
  deviceType: number;
  run: boolean;
  targetSpeedRpm: number;
  faultClear: boolean;
  reserved: number;
};

type LowerBoardSimStatusFrame = {
  deviceType: number;
  currentSpeedRpm: number;
  busVoltageV: number;
  busCurrentMa: number;
  motorPowerW: number;
  boardTemperatureC: number;
  faultCode: number;
};

type LowerBoardSimStats = {
  rxBytes: number;
  txBytes: number;
  commandFrames: number;
  statusFrames: number;
  crcErrors: number;
  syncErrors: number;
  droppedResponses: number;
  badChecksumResponses: number;
  faultClearPulses: number;
  lastCommand?: LowerBoardSimCommandFrame;
  lastStatus?: LowerBoardSimStatusFrame;
};

type LowerBoardSimStatusEvent = {
  status: SerialConnectionStatus;
  running: boolean;
  message: string;
  port: string;
  config: LowerBoardSimConfig;
  stats: LowerBoardSimStats;
  timestamp: number;
};

type LowerBoardSimFrameEvent = {
  direction: "rx" | "tx";
  frameType: "command" | "status" | "error";
  hex: string;
  message: string;
  command?: LowerBoardSimCommandFrame;
  statusFrame?: LowerBoardSimStatusFrame;
  timestamp: number;
};

type RunningAction = {
  id: string;
  process: ChildProcessWithoutNullStreams;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let runningAction: RunningAction | null = null;
let activeSerialPort: SerialPort | null = null;
let activeSerialConfig: SerialConfig | null = null;
let activeSerialResolvedPort = "";
let manualSerialClose = false;
let serialReconnectTimer: NodeJS.Timeout | null = null;
let serialSignalTimer: NodeJS.Timeout | null = null;
let serialSignals: SerialLineSignals = {
  dtr: false,
  rts: false,
  cts: null,
  dsr: null,
  dcd: null
};
let lastSerialSignalSnapshot = JSON.stringify(serialSignals);
let lowerBoardSimPort: SerialPort | null = null;
let lowerBoardSimConfig: LowerBoardSimConfig | null = null;
let lowerBoardSimResolvedPort = "";
let lowerBoardSimBuffer = Buffer.alloc(0);
let lowerBoardSimCurrentSpeedRpm = 0;
let lowerBoardSimLastUpdateAt = Date.now();
let lowerBoardSimResponseTimers = new Set<NodeJS.Timeout>();
let lowerBoardSimStats: LowerBoardSimStats = {
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

const defaultConfig: EspConfig = {
  chip: "esp32",
  port: "",
  baud: 460800,
  monitorBaud: 115200,
  idfExport: "C:\\esp\\v5.4.4\\esp-idf\\export.bat",
  projectDir: "",
  firmwareDir: "",
  skipBuildOnFlash: true,
  autoPort: false,
  manualDownloadMode: true,
  openMonitorAfterFlash: false,
  logDir: "logs"
};

const defaultSerialConfig: SerialConfig = {
  port: "",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  textEncoding: "utf-8",
  receiveMode: "text",
  sendMode: "text",
  showTimestamp: true,
  frameGapMs: 20,
  terminalMode: false,
  showSent: true,
  timedSend: false,
  timedSendIntervalMs: 1000,
  autoOpen: false,
  autoReconnect: true,
  dtr: false,
  rts: false
};

const lowerBoardSimProtocol = {
  baudRate: 4800,
  commandFrameSize: 9,
  statusFrameSize: 15,
  header1: 0x5a,
  header2: 0xa5,
  temperatureOffset: 40,
  minSpeedRpm: 500,
  maxSpeedRpm: 4000,
  defaultDeviceType: 0x02
};

const defaultLowerBoardSimConfig: LowerBoardSimConfig = {
  port: "",
  deviceType: lowerBoardSimProtocol.defaultDeviceType,
  busVoltageV: 230,
  boardTemperatureC: 25,
  faultCode: 0,
  speedRampRpmPerSecond: 1200,
  responseDelayMs: 10,
  offlineMode: false,
  dropRatePercent: 0,
  badChecksumRatePercent: 0
};

function getEspToolDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "esp-flasher");
  }

  return path.join(app.getAppPath(), "resources", "esp-flasher");
}

function getUserEspDir() {
  return path.join(app.getPath("userData"), "esp-flasher");
}

function shouldSkipEspToolFile(relativePath: string) {
  return relativePath === "flash_tool.config.json" || relativePath === "logs" || relativePath.startsWith(`logs${path.sep}`);
}

function copyBundledEspToolDir(sourceRoot: string, targetRoot: string, currentDir = sourceRoot) {
  if (!fs.existsSync(currentDir)) {
    return;
  }

  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const sourcePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath);

    if (shouldSkipEspToolFile(relativePath)) {
      continue;
    }

    const targetPath = path.join(targetRoot, relativePath);

    if (entry.isDirectory()) {
      copyBundledEspToolDir(sourceRoot, targetRoot, sourcePath);
      continue;
    }

    if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function syncBundledEspTool() {
  const bundledDir = getEspToolDir();
  const userDir = getUserEspDir();

  fs.mkdirSync(userDir, { recursive: true });

  if (fs.existsSync(bundledDir)) {
    copyBundledEspToolDir(bundledDir, userDir);
  }

  return userDir;
}

function getRunnableEspToolDir() {
  return syncBundledEspTool();
}

function getUserConfigPath() {
  return path.join(getUserEspDir(), "flash_tool.config.json");
}

function getSerialConfigPath() {
  return path.join(app.getPath("userData"), "serial-assistant.config.json");
}

function getLowerBoardSimConfigPath() {
  return path.join(app.getPath("userData"), "lower-board-sim.config.json");
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function sanitizeConfig(input: Partial<EspConfig> | null | undefined): EspConfig {
  const merged = { ...defaultConfig, ...(input ?? {}) };
  const rawPort = String(merged.port || "").trim().toUpperCase();

  return {
    chip: String(merged.chip || "esp32").trim().toLowerCase(),
    port: rawPort === "AUTO" ? "" : rawPort,
    baud: Number(merged.baud) || defaultConfig.baud,
    monitorBaud: Number(merged.monitorBaud) || defaultConfig.monitorBaud,
    idfExport: String(merged.idfExport || ""),
    projectDir: String(merged.projectDir || ""),
    firmwareDir: String(merged.firmwareDir || ""),
    skipBuildOnFlash: Boolean(merged.skipBuildOnFlash),
    autoPort: false,
    manualDownloadMode: Boolean(merged.manualDownloadMode),
    openMonitorAfterFlash: Boolean(merged.openMonitorAfterFlash),
    logDir: String(merged.logDir || "logs")
  };
}

function sanitizeSerialConfig(input: Partial<SerialConfig> | null | undefined): SerialConfig {
  const merged = { ...defaultSerialConfig, ...(input ?? {}) };
  const dataBits = [5, 6, 7, 8].includes(Number(merged.dataBits)) ? (Number(merged.dataBits) as SerialDataBits) : 8;
  const stopBits = [1, 1.5, 2].includes(Number(merged.stopBits)) ? (Number(merged.stopBits) as SerialStopBits) : 1;
  const parityOptions: SerialParity[] = ["none", "even", "odd", "mark", "space"];
  const textEncodingOptions: SerialTextEncoding[] = ["utf-8", "gbk"];
  const displayModeOptions: SerialDisplayMode[] = ["text", "hex"];
  const parity = parityOptions.includes(merged.parity) ? merged.parity : "none";
  const textEncoding = textEncodingOptions.includes(merged.textEncoding) ? merged.textEncoding : "utf-8";
  const receiveMode = displayModeOptions.includes(merged.receiveMode) ? merged.receiveMode : "text";
  const sendMode = displayModeOptions.includes(merged.sendMode) ? merged.sendMode : "text";
  const rawPort = String(merged.port || "").trim().toUpperCase();
  const baudRate = Number(merged.baudRate);
  const frameGapMs = Number(merged.frameGapMs);
  const timedSendIntervalMs = Number(merged.timedSendIntervalMs);

  return {
    port: rawPort === "AUTO" ? "" : rawPort,
    baudRate: Number.isFinite(baudRate) && baudRate > 0 ? Math.round(baudRate) : defaultSerialConfig.baudRate,
    dataBits,
    parity,
    stopBits,
    textEncoding,
    receiveMode,
    sendMode,
    showTimestamp: Boolean(merged.showTimestamp),
    frameGapMs: Number.isFinite(frameGapMs) && frameGapMs >= 0 ? Math.round(frameGapMs) : defaultSerialConfig.frameGapMs,
    terminalMode: Boolean(merged.terminalMode),
    showSent: Boolean(merged.showSent),
    timedSend: Boolean(merged.timedSend),
    timedSendIntervalMs:
      Number.isFinite(timedSendIntervalMs) && timedSendIntervalMs >= 100
        ? Math.round(timedSendIntervalMs)
        : defaultSerialConfig.timedSendIntervalMs,
    autoOpen: Boolean(merged.autoOpen),
    autoReconnect: Boolean(merged.autoReconnect),
    dtr: Boolean(merged.dtr),
    rts: Boolean(merged.rts)
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numericValue));
}

function sanitizeLowerBoardSimConfig(input: Partial<LowerBoardSimConfig> | null | undefined): LowerBoardSimConfig {
  const merged = { ...defaultLowerBoardSimConfig, ...(input ?? {}) };
  const rawPort = String(merged.port || "").trim().toUpperCase();
  const deviceType = Math.round(
    clampNumber(merged.deviceType, 1, 9, defaultLowerBoardSimConfig.deviceType)
  );

  return {
    port: rawPort === "AUTO" ? "" : rawPort,
    deviceType,
    busVoltageV: Math.round(clampNumber(merged.busVoltageV, 0, 65535, defaultLowerBoardSimConfig.busVoltageV)),
    boardTemperatureC: Math.round(clampNumber(merged.boardTemperatureC, -40, 215, defaultLowerBoardSimConfig.boardTemperatureC)),
    faultCode: Math.round(clampNumber(merged.faultCode, 0, 65535, defaultLowerBoardSimConfig.faultCode)),
    speedRampRpmPerSecond: Math.round(
      clampNumber(merged.speedRampRpmPerSecond, 1, 10000, defaultLowerBoardSimConfig.speedRampRpmPerSecond)
    ),
    responseDelayMs: Math.round(clampNumber(merged.responseDelayMs, 0, 5000, defaultLowerBoardSimConfig.responseDelayMs)),
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

function readDefaultConfig() {
  const examplePath = path.join(getRunnableEspToolDir(), "flash_tool.config.example.json");
  return sanitizeConfig(readJsonFile<Partial<EspConfig>>(examplePath, defaultConfig));
}

function ensureUserConfig() {
  const userDir = getUserEspDir();
  const configPath = getUserConfigPath();

  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(readDefaultConfig(), null, 2), "utf8");
  }
}

function readUserConfig() {
  ensureUserConfig();
  return sanitizeConfig(readJsonFile<Partial<EspConfig>>(getUserConfigPath(), readDefaultConfig()));
}

function writeUserConfig(config: Partial<EspConfig>) {
  ensureUserConfig();
  const sanitized = sanitizeConfig(config);
  fs.writeFileSync(getUserConfigPath(), JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

function ensureSerialConfig() {
  const configPath = getSerialConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultSerialConfig, null, 2), "utf8");
  }
}

function readSerialConfig() {
  ensureSerialConfig();
  return sanitizeSerialConfig(readJsonFile<Partial<SerialConfig>>(getSerialConfigPath(), defaultSerialConfig));
}

function writeSerialConfig(config: Partial<SerialConfig>) {
  ensureSerialConfig();
  const sanitized = sanitizeSerialConfig(config);
  fs.writeFileSync(getSerialConfigPath(), JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

function ensureLowerBoardSimConfig() {
  const configPath = getLowerBoardSimConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultLowerBoardSimConfig, null, 2), "utf8");
  }
}

function readLowerBoardSimConfig() {
  ensureLowerBoardSimConfig();
  return sanitizeLowerBoardSimConfig(
    readJsonFile<Partial<LowerBoardSimConfig>>(getLowerBoardSimConfigPath(), defaultLowerBoardSimConfig)
  );
}

function writeLowerBoardSimConfig(config: Partial<LowerBoardSimConfig>) {
  ensureLowerBoardSimConfig();
  const sanitized = sanitizeLowerBoardSimConfig(config);
  fs.writeFileSync(getLowerBoardSimConfigPath(), JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

function quotePowerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildEncodedPowerShell(command: string) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function buildPowerShellInvocation(scriptPath: string, args: string[]) {
  const tokens = [
    quotePowerShellString(scriptPath),
    ...args.map((arg) => (arg.startsWith("-") ? arg : quotePowerShellString(arg)))
  ];

  return [
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    `$env:PYTHONIOENCODING = 'utf-8'`,
    `& ${tokens.join(" ")}`
  ].join("; ");
}

function spawnPowerShell(command: string, cwd: string) {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", buildEncodedPowerShell(command)],
    {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    }
  );
}

function getRunArgs(action: EspAction, config: EspConfig) {
  const args = [
    "-Action",
    action,
    "-Config",
    getUserConfigPath(),
    "-NoPause",
    "-Chip",
    config.chip,
    "-Port",
    config.port,
    "-Baud",
    String(config.baud),
    "-MonitorBaud",
    String(config.monitorBaud)
  ];

  if (config.idfExport) {
    args.push("-IdfExport", config.idfExport);
  }

  if (config.projectDir) {
    args.push("-ProjectDir", config.projectDir);
  }

  if (config.firmwareDir) {
    args.push("-FirmwareDir", config.firmwareDir);
  }

  if (config.skipBuildOnFlash && action === "Flash") {
    args.push("-SkipBuild");
  }

  if (config.openMonitorAfterFlash && action === "Flash") {
    args.push("-OpenMonitorAfterFlash");
  }

  return args;
}

async function runListPorts() {
  const script = [
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object { if ($_ -match '^COM(\\d+)$') { [int]$Matches[1] } else { 9999 } })",
    "[Console]::Out.Write(($ports | ConvertTo-Json -Compress))"
  ].join("; ");

  return new Promise<string[]>((resolve) => {
    const child = spawnPowerShell(script, getRunnableEspToolDir());
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.on("close", () => {
      try {
        const parsed = JSON.parse(output.trim() || "[]") as string[] | string;
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        resolve([]);
      }
    });

    child.on("error", () => resolve([]));
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compareSerialPortPath(a: string, b: string) {
  const aMatch = /^COM(\d+)$/i.exec(a);
  const bMatch = /^COM(\d+)$/i.exec(b);

  if (aMatch && bMatch) {
    return Number(aMatch[1]) - Number(bMatch[1]);
  }

  if (aMatch) {
    return -1;
  }

  if (bMatch) {
    return 1;
  }

  return a.localeCompare(b);
}

async function listSerialPorts() {
  const ports = await SerialPort.list();

  return ports
    .map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      pnpId: port.pnpId,
      locationId: port.locationId,
      productId: port.productId,
      vendorId: port.vendorId
    }))
    .sort((a, b) => compareSerialPortPath(a.path, b.path));
}

async function resolveSerialPortPath(config: SerialConfig) {
  const ports = await listSerialPorts();

  if (!config.port) {
    throw new Error("请先选择串口。");
  }

  const matchedPort = ports.find((port) => port.path.toUpperCase() === config.port.toUpperCase());
  if (!matchedPort) {
    const portText = ports.length > 0 ? ports.map((port) => port.path).join(", ") : "无";
    throw new Error(`未找到串口 ${config.port}。当前串口: ${portText}`);
  }

  return matchedPort.path;
}

function makeSerialStatus(status: SerialConnectionStatus, message: string): SerialStatusEvent {
  return {
    status,
    connected: status === "open",
    message,
    port: activeSerialResolvedPort || activeSerialConfig?.port || "",
    signals: serialSignals,
    timestamp: Date.now()
  };
}

function emitSerialStatus(status: SerialConnectionStatus, message: string) {
  const event = makeSerialStatus(status, message);
  mainWindow?.webContents.send("serial:status", event);
  return event;
}

function emitSerialData(direction: "rx" | "tx", data: Buffer) {
  mainWindow?.webContents.send("serial:data", {
    direction,
    base64: data.toString("base64"),
    byteLength: data.length,
    timestamp: Date.now()
  });
}

function clearSerialReconnectTimer() {
  if (serialReconnectTimer) {
    clearTimeout(serialReconnectTimer);
    serialReconnectTimer = null;
  }
}

function clearSerialSignalTimer() {
  if (serialSignalTimer) {
    clearInterval(serialSignalTimer);
    serialSignalTimer = null;
  }
}

function setActiveSerialSignals(nextSignals: Partial<SerialLineSignals>) {
  serialSignals = {
    ...serialSignals,
    ...nextSignals
  };
}

function updateSerialSignalsFromPort(port: SerialPort) {
  if (!port.isOpen) {
    return;
  }

  port.get((error, modemBits) => {
    if (error || !modemBits) {
      return;
    }

    setActiveSerialSignals({
      cts: modemBits.cts,
      dsr: modemBits.dsr,
      dcd: modemBits.dcd
    });

    const snapshot = JSON.stringify(serialSignals);
    if (snapshot !== lastSerialSignalSnapshot) {
      lastSerialSignalSnapshot = snapshot;
      emitSerialStatus("open", "状态线已更新");
    }
  });
}

function startSerialSignalPolling(port: SerialPort) {
  clearSerialSignalTimer();
  updateSerialSignalsFromPort(port);
  serialSignalTimer = setInterval(() => updateSerialSignalsFromPort(port), 1000);
}

function setPortControlLines(port: SerialPort, dtr: boolean, rts: boolean) {
  return new Promise<void>((resolve, reject) => {
    port.set({ dtr, rts }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function openPort(port: SerialPort) {
  return new Promise<void>((resolve, reject) => {
    port.open((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closePort(port: SerialPort) {
  return new Promise<void>((resolve, reject) => {
    port.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function encodeSerialWritePayload(payload: SerialWritePayload) {
  if (payload.mode === "hex") {
    const cleaned = payload.data.replace(/0x/gi, "").replace(/[\s,;:_-]/g, "");

    if (!cleaned) {
      throw new Error("HEX 发送内容为空。");
    }

    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
      throw new Error("HEX 发送内容包含非十六进制字符。");
    }

    if (cleaned.length % 2 !== 0) {
      throw new Error("HEX 发送内容必须是偶数字符。");
    }

    return Buffer.from(cleaned, "hex");
  }

  const data = payload.data + (payload.appendLineEnding ? "\r\n" : "");
  if (!data) {
    throw new Error("发送内容为空。");
  }

  return iconv.encode(data, payload.encoding === "gbk" ? "gbk" : "utf8");
}

function writeSerialData(payload: SerialWritePayload) {
  const port = activeSerialPort;
  if (!port || !port.isOpen) {
    throw new Error("串口未打开。");
  }

  const data = encodeSerialWritePayload(payload);

  return new Promise<{ bytesWritten: number }>((resolve, reject) => {
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

        emitSerialData("tx", data);
        resolve({ bytesWritten: data.length });
      });
    });
  });
}

function scheduleSerialReconnect(config: SerialConfig) {
  if (manualSerialClose || !config.autoReconnect) {
    return;
  }

  clearSerialReconnectTimer();
  emitSerialStatus("reconnecting", "串口断开，准备自动重连");

  serialReconnectTimer = setTimeout(() => {
    serialReconnectTimer = null;
    void openSerialConnection(config, true).catch(() => {
      scheduleSerialReconnect(config);
    });
  }, 1200);
}

async function openSerialConnection(rawConfig: Partial<SerialConfig>, isReconnectAttempt = false) {
  if (activeSerialPort) {
    throw new Error("已有串口连接正在进行。");
  }

  clearSerialReconnectTimer();
  const config = writeSerialConfig(rawConfig);
  activeSerialConfig = config;
  manualSerialClose = false;
  setActiveSerialSignals({
    dtr: config.dtr,
    rts: config.rts,
    cts: null,
    dsr: null,
    dcd: null
  });

  const resolvedPort = await resolveSerialPortPath(config);
  if (lowerBoardSimPort?.isOpen && lowerBoardSimResolvedPort.toUpperCase() === resolvedPort.toUpperCase()) {
    throw new Error(`串口 ${resolvedPort} 已被下板模拟占用。请先停止下板模拟。`);
  }
  activeSerialResolvedPort = resolvedPort;
  emitSerialStatus(isReconnectAttempt ? "reconnecting" : "opening", `正在打开 ${resolvedPort}`);

  const port = new SerialPort({
    path: resolvedPort,
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    autoOpen: false
  });

  activeSerialPort = port;

  port.on("data", (chunk: Buffer) => {
    emitSerialData("rx", chunk);
  });

  port.on("error", (error: Error) => {
    emitSerialStatus("error", `串口错误: ${error.message}`);
  });

  port.on("close", (error?: Error) => {
    clearSerialSignalTimer();
    if (activeSerialPort === port) {
      activeSerialPort = null;
    }

    const configForReconnect = activeSerialConfig;
    const message = error ? `串口已断开: ${error.message}` : "串口已关闭";

    if (configForReconnect && !manualSerialClose && configForReconnect.autoReconnect) {
      emitSerialStatus("reconnecting", message);
      scheduleSerialReconnect(configForReconnect);
      return;
    }

    emitSerialStatus(error ? "error" : "closed", message);
  });

  try {
    await openPort(port);
    await setPortControlLines(port, config.dtr, config.rts);
    startSerialSignalPolling(port);
    return emitSerialStatus("open", `已打开 ${resolvedPort}`);
  } catch (error) {
    clearSerialSignalTimer();
    port.removeAllListeners();
    if (activeSerialPort === port) {
      activeSerialPort = null;
    }
    emitSerialStatus("error", `打开串口失败: ${getErrorMessage(error)}`);
    throw error;
  }
}

async function closeSerialConnection() {
  manualSerialClose = true;
  clearSerialReconnectTimer();
  clearSerialSignalTimer();

  const port = activeSerialPort;
  if (!port) {
    activeSerialPort = null;
    return emitSerialStatus("closed", "串口未打开");
  }

  emitSerialStatus("closing", "正在关闭串口");

  if (!port.isOpen) {
    port.removeAllListeners();
    activeSerialPort = null;
    return emitSerialStatus("closed", "串口已关闭");
  }

  await closePort(port);
  return makeSerialStatus("closed", "串口已关闭");
}

async function setSerialControlLines(signals: Pick<SerialLineSignals, "dtr" | "rts">) {
  const config = writeSerialConfig({
    ...(activeSerialConfig ?? readSerialConfig()),
    dtr: signals.dtr,
    rts: signals.rts
  });
  activeSerialConfig = config;
  setActiveSerialSignals({ dtr: config.dtr, rts: config.rts });

  if (activeSerialPort?.isOpen) {
    await setPortControlLines(activeSerialPort, config.dtr, config.rts);
    updateSerialSignalsFromPort(activeSerialPort);
  }

  emitSerialStatus(activeSerialPort?.isOpen ? "open" : "closed", "控制线已更新");
  return serialSignals;
}

function cloneLowerBoardSimConfig(config: LowerBoardSimConfig) {
  return { ...config };
}

function cloneLowerBoardSimStats(stats: LowerBoardSimStats) {
  return {
    ...stats,
    lastCommand: stats.lastCommand ? { ...stats.lastCommand } : undefined,
    lastStatus: stats.lastStatus ? { ...stats.lastStatus } : undefined
  };
}

function resetLowerBoardSimStats() {
  lowerBoardSimStats = {
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

function lowerBoardSimHex(data: Buffer | Uint8Array) {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function lowerBoardSimXor8(data: Buffer | Uint8Array, length: number) {
  let checksum = 0;

  for (let index = 0; index < length; index += 1) {
    checksum ^= data[index] ?? 0;
  }

  return checksum & 0xff;
}

function makeLowerBoardSimStatus(status: SerialConnectionStatus, message: string): LowerBoardSimStatusEvent {
  const config = lowerBoardSimConfig ?? readLowerBoardSimConfig();

  return {
    status,
    running: status === "open",
    message,
    port: lowerBoardSimResolvedPort || config.port,
    config: cloneLowerBoardSimConfig(config),
    stats: cloneLowerBoardSimStats(lowerBoardSimStats),
    timestamp: Date.now()
  };
}

function emitLowerBoardSimStatus(status: SerialConnectionStatus, message: string) {
  const event = makeLowerBoardSimStatus(status, message);
  mainWindow?.webContents.send("lower-board-sim:status", event);
  return event;
}

function emitLowerBoardSimFrame(event: Omit<LowerBoardSimFrameEvent, "timestamp">) {
  const payload: LowerBoardSimFrameEvent = {
    ...event,
    timestamp: Date.now()
  };

  mainWindow?.webContents.send("lower-board-sim:frame", payload);
}

function clearLowerBoardSimTimers() {
  lowerBoardSimResponseTimers.forEach((timer) => clearTimeout(timer));
  lowerBoardSimResponseTimers.clear();
}

function writeLowerBoardSimU16(frame: Buffer, highIndex: number, value: number) {
  const sanitized = Math.round(clampNumber(value, 0, 65535, 0));
  frame[highIndex] = (sanitized >> 8) & 0xff;
  frame[highIndex + 1] = sanitized & 0xff;
}

function readLowerBoardSimU16(frame: Buffer, highIndex: number) {
  return ((frame[highIndex] ?? 0) << 8) | (frame[highIndex + 1] ?? 0);
}

function decodeLowerBoardSimCommand(frame: Buffer): LowerBoardSimCommandFrame {
  return {
    deviceType: frame[2] ?? 0,
    run: (frame[3] ?? 0) !== 0,
    targetSpeedRpm: readLowerBoardSimU16(frame, 4),
    faultClear: (frame[6] ?? 0) !== 0,
    reserved: frame[7] ?? 0
  };
}

function isLowerBoardSimKnownDeviceType(deviceType: number) {
  return deviceType >= 1 && deviceType <= 9;
}

function advanceLowerBoardSimSpeed(command: LowerBoardSimCommandFrame, config: LowerBoardSimConfig) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - lowerBoardSimLastUpdateAt) / 1000);
  const targetSpeedRpm = command.run
    ? Math.round(
        clampNumber(
          command.targetSpeedRpm,
          lowerBoardSimProtocol.minSpeedRpm,
          lowerBoardSimProtocol.maxSpeedRpm,
          lowerBoardSimProtocol.minSpeedRpm
        )
      )
    : 0;
  const maxStep = config.speedRampRpmPerSecond * elapsedSeconds;
  const delta = targetSpeedRpm - lowerBoardSimCurrentSpeedRpm;

  if (Math.abs(delta) <= maxStep) {
    lowerBoardSimCurrentSpeedRpm = targetSpeedRpm;
  } else {
    lowerBoardSimCurrentSpeedRpm += Math.sign(delta) * maxStep;
  }

  lowerBoardSimCurrentSpeedRpm = Math.round(
    clampNumber(lowerBoardSimCurrentSpeedRpm, 0, lowerBoardSimProtocol.maxSpeedRpm, 0)
  );
  lowerBoardSimLastUpdateAt = now;
}

function buildLowerBoardSimStatus(command: LowerBoardSimCommandFrame): LowerBoardSimStatusFrame {
  const config = lowerBoardSimConfig ?? readLowerBoardSimConfig();

  advanceLowerBoardSimSpeed(command, config);

  const speedRatio = lowerBoardSimCurrentSpeedRpm / lowerBoardSimProtocol.maxSpeedRpm;
  const busCurrentMa = lowerBoardSimCurrentSpeedRpm > 0 ? Math.round(500 + speedRatio * 3500) : 0;
  const motorPowerW = lowerBoardSimCurrentSpeedRpm > 0 ? Math.round((config.busVoltageV * busCurrentMa) / 1000) : 0;

  return {
    deviceType: config.deviceType,
    currentSpeedRpm: lowerBoardSimCurrentSpeedRpm,
    busVoltageV: config.busVoltageV,
    busCurrentMa,
    motorPowerW,
    boardTemperatureC: config.boardTemperatureC,
    faultCode: config.faultCode
  };
}

function encodeLowerBoardSimStatus(status: LowerBoardSimStatusFrame, corruptChecksum: boolean) {
  const frame = Buffer.alloc(lowerBoardSimProtocol.statusFrameSize);

  frame[0] = lowerBoardSimProtocol.header1;
  frame[1] = lowerBoardSimProtocol.header2;
  frame[2] = status.deviceType & 0xff;
  writeLowerBoardSimU16(frame, 3, status.currentSpeedRpm);
  writeLowerBoardSimU16(frame, 5, status.busVoltageV);
  writeLowerBoardSimU16(frame, 7, status.busCurrentMa);
  writeLowerBoardSimU16(frame, 9, status.motorPowerW);
  frame[11] = Math.round(
    clampNumber(status.boardTemperatureC + lowerBoardSimProtocol.temperatureOffset, 0, 255, lowerBoardSimProtocol.temperatureOffset)
  );
  writeLowerBoardSimU16(frame, 12, status.faultCode);
  frame[14] = lowerBoardSimXor8(frame, 14);

  if (corruptChecksum) {
    frame[14] ^= 0x01;
  }

  return frame;
}

function writeLowerBoardSimResponse(command: LowerBoardSimCommandFrame, corruptChecksum: boolean) {
  const port = lowerBoardSimPort;
  if (!port || !port.isOpen) {
    return;
  }

  const status = buildLowerBoardSimStatus(command);
  const frame = encodeLowerBoardSimStatus(status, corruptChecksum);

  port.write(frame, (writeError) => {
    if (writeError) {
      emitLowerBoardSimStatus("error", `下板模拟回包失败: ${writeError.message}`);
      return;
    }

    port.drain((drainError) => {
      if (drainError) {
        emitLowerBoardSimStatus("error", `下板模拟回包 drain 失败: ${drainError.message}`);
        return;
      }

      lowerBoardSimStats.txBytes += frame.length;
      lowerBoardSimStats.statusFrames += 1;
      lowerBoardSimStats.lastStatus = status;
      if (corruptChecksum) {
        lowerBoardSimStats.badChecksumResponses += 1;
      }

      emitLowerBoardSimFrame({
        direction: "tx",
        frameType: "status",
        hex: lowerBoardSimHex(frame),
        message: corruptChecksum ? "已发送坏校验状态帧" : "已发送状态帧",
        statusFrame: status
      });
      emitLowerBoardSimStatus("open", "下板模拟运行中");
    });
  });
}

function scheduleLowerBoardSimResponse(command: LowerBoardSimCommandFrame) {
  const config = lowerBoardSimConfig ?? readLowerBoardSimConfig();
  const shouldDrop = config.offlineMode || Math.random() * 100 < config.dropRatePercent;

  if (shouldDrop) {
    lowerBoardSimStats.droppedResponses += 1;
    emitLowerBoardSimFrame({
      direction: "tx",
      frameType: "error",
      hex: "",
      message: config.offlineMode ? "离线模式: 已抑制回包" : "丢包注入: 已抑制回包"
    });
    emitLowerBoardSimStatus("open", "已接收命令但未回包");
    return;
  }

  const corruptChecksum = Math.random() * 100 < config.badChecksumRatePercent;
  const timer = setTimeout(() => {
    lowerBoardSimResponseTimers.delete(timer);
    writeLowerBoardSimResponse(command, corruptChecksum);
  }, config.responseDelayMs);

  lowerBoardSimResponseTimers.add(timer);
}

function handleLowerBoardSimCommand(frame: Buffer) {
  if (frame[8] !== lowerBoardSimXor8(frame, 8)) {
    lowerBoardSimStats.crcErrors += 1;
    emitLowerBoardSimFrame({
      direction: "rx",
      frameType: "error",
      hex: lowerBoardSimHex(frame),
      message: "命令帧 XOR8 校验失败"
    });
    return;
  }

  const command = decodeLowerBoardSimCommand(frame);
  if (!isLowerBoardSimKnownDeviceType(command.deviceType)) {
    lowerBoardSimStats.syncErrors += 1;
    emitLowerBoardSimFrame({
      direction: "rx",
      frameType: "error",
      hex: lowerBoardSimHex(frame),
      message: `未知设备类型: 0x${command.deviceType.toString(16).padStart(2, "0").toUpperCase()}`
    });
    return;
  }

  lowerBoardSimStats.commandFrames += 1;
  lowerBoardSimStats.lastCommand = command;
  emitLowerBoardSimFrame({
    direction: "rx",
    frameType: "command",
    hex: lowerBoardSimHex(frame),
    message: `命令 run=${command.run ? "1" : "0"} speed=${command.targetSpeedRpm} faultClear=${command.faultClear ? "1" : "0"}`,
    command
  });

  if (command.faultClear) {
    lowerBoardSimStats.faultClearPulses += 1;
    lowerBoardSimConfig = writeLowerBoardSimConfig({
      ...(lowerBoardSimConfig ?? readLowerBoardSimConfig()),
      faultCode: 0
    });
  }

  scheduleLowerBoardSimResponse(command);
}

function processLowerBoardSimBuffer() {
  for (;;) {
    if (lowerBoardSimBuffer.length === 0) {
      return;
    }

    if (lowerBoardSimBuffer[0] !== lowerBoardSimProtocol.header1) {
      const skipped = lowerBoardSimBuffer.subarray(0, 1);
      lowerBoardSimStats.syncErrors += 1;
      lowerBoardSimBuffer = lowerBoardSimBuffer.subarray(1);
      emitLowerBoardSimFrame({
        direction: "rx",
        frameType: "error",
        hex: lowerBoardSimHex(skipped),
        message: "同步失败: 丢弃非帧头字节"
      });
      continue;
    }

    if (lowerBoardSimBuffer.length < 2) {
      return;
    }

    if (lowerBoardSimBuffer[1] !== lowerBoardSimProtocol.header2) {
      const skipped = lowerBoardSimBuffer.subarray(0, 2);
      lowerBoardSimStats.syncErrors += 1;
      lowerBoardSimBuffer = lowerBoardSimBuffer.subarray(1);
      emitLowerBoardSimFrame({
        direction: "rx",
        frameType: "error",
        hex: lowerBoardSimHex(skipped),
        message: "同步失败: 帧头第二字节不匹配"
      });
      continue;
    }

    if (lowerBoardSimBuffer.length < lowerBoardSimProtocol.commandFrameSize) {
      return;
    }

    const frame = Buffer.from(lowerBoardSimBuffer.subarray(0, lowerBoardSimProtocol.commandFrameSize));
    lowerBoardSimBuffer = lowerBoardSimBuffer.subarray(lowerBoardSimProtocol.commandFrameSize);
    handleLowerBoardSimCommand(frame);
  }
}

function handleLowerBoardSimData(chunk: Buffer) {
  lowerBoardSimStats.rxBytes += chunk.length;
  lowerBoardSimBuffer = Buffer.concat([lowerBoardSimBuffer, chunk]);
  processLowerBoardSimBuffer();
  emitLowerBoardSimStatus("open", "下板模拟运行中");
}

async function resolveLowerBoardSimPortPath(config: LowerBoardSimConfig) {
  const ports = await listSerialPorts();

  if (!config.port) {
    throw new Error("请先选择 USB-TTL 串口。");
  }

  const matchedPort = ports.find((port) => port.path.toUpperCase() === config.port.toUpperCase());
  if (!matchedPort) {
    const portText = ports.length > 0 ? ports.map((port) => port.path).join(", ") : "无";
    throw new Error(`未找到串口 ${config.port}。当前串口: ${portText}`);
  }

  return matchedPort.path;
}

function ensureLowerBoardSimPortAvailable(resolvedPort: string) {
  if (activeSerialPort?.isOpen && activeSerialResolvedPort.toUpperCase() === resolvedPort.toUpperCase()) {
    throw new Error(`串口 ${resolvedPort} 已被串口助手占用。请先关闭串口助手连接。`);
  }
}

async function startLowerBoardSimConnection(rawConfig: Partial<LowerBoardSimConfig>) {
  if (lowerBoardSimPort) {
    throw new Error("下板模拟已在运行。");
  }

  const config = writeLowerBoardSimConfig(rawConfig);
  const resolvedPort = await resolveLowerBoardSimPortPath(config);
  ensureLowerBoardSimPortAvailable(resolvedPort);

  lowerBoardSimConfig = config;
  lowerBoardSimResolvedPort = resolvedPort;
  lowerBoardSimBuffer = Buffer.alloc(0);
  lowerBoardSimCurrentSpeedRpm = 0;
  lowerBoardSimLastUpdateAt = Date.now();
  resetLowerBoardSimStats();
  emitLowerBoardSimStatus("opening", `正在打开 ${resolvedPort}`);

  const port = new SerialPort({
    path: resolvedPort,
    baudRate: lowerBoardSimProtocol.baudRate,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    autoOpen: false
  });

  lowerBoardSimPort = port;

  port.on("data", (chunk: Buffer) => handleLowerBoardSimData(chunk));
  port.on("error", (error: Error) => {
    emitLowerBoardSimStatus("error", `下板模拟串口错误: ${error.message}`);
  });
  port.on("close", (error?: Error) => {
    clearLowerBoardSimTimers();
    if (lowerBoardSimPort === port) {
      lowerBoardSimPort = null;
    }
    emitLowerBoardSimStatus(error ? "error" : "closed", error ? `下板模拟已断开: ${error.message}` : "下板模拟已停止");
  });

  try {
    await openPort(port);
    return emitLowerBoardSimStatus("open", `下板模拟已启动 ${resolvedPort} / 4800 8N1`);
  } catch (error) {
    clearLowerBoardSimTimers();
    port.removeAllListeners();
    if (lowerBoardSimPort === port) {
      lowerBoardSimPort = null;
    }
    emitLowerBoardSimStatus("error", `打开下板模拟串口失败: ${getErrorMessage(error)}`);
    throw error;
  }
}

async function stopLowerBoardSimConnection() {
  clearLowerBoardSimTimers();

  const port = lowerBoardSimPort;
  if (!port) {
    lowerBoardSimPort = null;
    return emitLowerBoardSimStatus("closed", "下板模拟未运行");
  }

  emitLowerBoardSimStatus("closing", "正在停止下板模拟");

  if (!port.isOpen) {
    port.removeAllListeners();
    lowerBoardSimPort = null;
    return emitLowerBoardSimStatus("closed", "下板模拟已停止");
  }

  await closePort(port);
  if (lowerBoardSimPort === port) {
    lowerBoardSimPort = null;
  }
  return makeLowerBoardSimStatus("closed", "下板模拟已停止");
}

function updateLowerBoardSimConfig(rawConfig: Partial<LowerBoardSimConfig>) {
  lowerBoardSimConfig = writeLowerBoardSimConfig(rawConfig);
  return emitLowerBoardSimStatus(lowerBoardSimPort?.isOpen ? "open" : "closed", "下板模拟配置已应用");
}

function resetLowerBoardSimStatsAndEmit() {
  resetLowerBoardSimStats();
  lowerBoardSimBuffer = Buffer.alloc(0);
  return emitLowerBoardSimStatus(lowerBoardSimPort?.isOpen ? "open" : "closed", "下板模拟统计已复位");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "AKI-TOOL",
    backgroundColor: "#f4f1ea",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("app:get-meta", () => ({
  name: "AKI-TOOL",
  version: app.getVersion()
}));

ipcMain.handle("esp:get-config", () => ({
  config: readUserConfig(),
  configPath: getUserConfigPath(),
  toolDir: getRunnableEspToolDir(),
  userDataDir: getUserEspDir()
}));

ipcMain.handle("esp:save-config", (_event, config: Partial<EspConfig>) => ({
  config: writeUserConfig(config),
  configPath: getUserConfigPath()
}));

ipcMain.handle("esp:list-ports", runListPorts);

ipcMain.handle("esp:run-action", (_event, payload: { action: EspAction; config: Partial<EspConfig> }) => {
  if (runningAction && !runningAction.process.killed) {
    throw new Error("已有任务正在执行。");
  }

  const actionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = writeUserConfig(payload.config);
  if (["Flash", "Erase", "Monitor"].includes(payload.action) && !config.port) {
    throw new Error("请先选择 ESP 串口。");
  }
  const toolDir = getRunnableEspToolDir();
  const scriptPath = path.join(toolDir, "esp_flash_tool.ps1");
  const command = buildPowerShellInvocation(scriptPath, getRunArgs(payload.action, config));
  const child = spawnPowerShell(command, toolDir);
  runningAction = { id: actionId, process: child };

  child.stdout.on("data", (chunk: Buffer) => {
    mainWindow?.webContents.send("esp:action-output", {
      id: actionId,
      stream: "stdout",
      text: chunk.toString("utf8")
    });
  });

  child.stderr.on("data", (chunk: Buffer) => {
    mainWindow?.webContents.send("esp:action-output", {
      id: actionId,
      stream: "stderr",
      text: chunk.toString("utf8")
    });
  });

  child.on("error", (error) => {
    mainWindow?.webContents.send("esp:action-output", {
      id: actionId,
      stream: "stderr",
      text: `${error.message}\n`
    });
  });

  child.on("close", (exitCode, signal) => {
    if (runningAction?.id === actionId) {
      runningAction = null;
    }

    mainWindow?.webContents.send("esp:action-finished", {
      id: actionId,
      exitCode,
      signal
    });
  });

  return { id: actionId };
});

ipcMain.handle("esp:stop-action", async () => {
  if (!runningAction) {
    return false;
  }

  const pid = runningAction.process.pid;
  if (process.platform === "win32" && pid) {
    spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    runningAction.process.kill("SIGTERM");
  }

  return true;
});

ipcMain.handle("serial:get-config", () => ({
  config: readSerialConfig(),
  configPath: getSerialConfigPath()
}));

ipcMain.handle("serial:save-config", (_event, config: Partial<SerialConfig>) => ({
  config: writeSerialConfig(config),
  configPath: getSerialConfigPath()
}));

ipcMain.handle("serial:list-ports", listSerialPorts);

ipcMain.handle("serial:open", (_event, config: Partial<SerialConfig>) => openSerialConnection(config));

ipcMain.handle("serial:close", closeSerialConnection);

ipcMain.handle("serial:write", (_event, payload: SerialWritePayload) => writeSerialData(payload));

ipcMain.handle("serial:set-control-lines", (_event, signals: Pick<SerialLineSignals, "dtr" | "rts">) =>
  setSerialControlLines(signals)
);

ipcMain.handle("lower-board-sim:get-config", () => ({
  config: readLowerBoardSimConfig(),
  configPath: getLowerBoardSimConfigPath()
}));

ipcMain.handle("lower-board-sim:save-config", (_event, config: Partial<LowerBoardSimConfig>) => ({
  config: writeLowerBoardSimConfig(config),
  configPath: getLowerBoardSimConfigPath()
}));

ipcMain.handle("lower-board-sim:list-ports", listSerialPorts);

ipcMain.handle("lower-board-sim:start", (_event, config: Partial<LowerBoardSimConfig>) => startLowerBoardSimConnection(config));

ipcMain.handle("lower-board-sim:stop", stopLowerBoardSimConnection);

ipcMain.handle("lower-board-sim:update-config", (_event, config: Partial<LowerBoardSimConfig>) => updateLowerBoardSimConfig(config));

ipcMain.handle("lower-board-sim:reset-stats", resetLowerBoardSimStatsAndEmit);

ipcMain.handle("dialog:select-directory", async () => {
  if (!mainWindow) {
    return "";
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });

  return result.canceled ? "" : result.filePaths[0] ?? "";
});

ipcMain.handle("dialog:select-file", async (_event, options?: { title?: string; filters?: Electron.FileFilter[] }) => {
  if (!mainWindow) {
    return "";
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title,
    filters: options?.filters,
    properties: ["openFile"]
  });

  return result.canceled ? "" : result.filePaths[0] ?? "";
});

ipcMain.handle("shell:open-path", (_event, targetPath: string) => shell.openPath(targetPath));
