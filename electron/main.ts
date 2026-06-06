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

const defaultConfig: EspConfig = {
  chip: "esp32",
  port: "AUTO",
  baud: 460800,
  monitorBaud: 115200,
  idfExport: "C:\\esp\\v5.4.4\\esp-idf\\export.bat",
  projectDir: "",
  firmwareDir: "",
  skipBuildOnFlash: true,
  autoPort: true,
  manualDownloadMode: true,
  openMonitorAfterFlash: false,
  logDir: "logs"
};

const defaultSerialConfig: SerialConfig = {
  port: "AUTO",
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

function getEspToolDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "esp-flasher");
  }

  return path.join(app.getAppPath(), "resources", "esp-flasher");
}

function getUserEspDir() {
  return path.join(app.getPath("userData"), "esp-flasher");
}

function getUserConfigPath() {
  return path.join(getUserEspDir(), "flash_tool.config.json");
}

function getSerialConfigPath() {
  return path.join(app.getPath("userData"), "serial-assistant.config.json");
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

  return {
    chip: String(merged.chip || "esp32").trim().toLowerCase(),
    port: String(merged.port || "AUTO").trim().toUpperCase(),
    baud: Number(merged.baud) || defaultConfig.baud,
    monitorBaud: Number(merged.monitorBaud) || defaultConfig.monitorBaud,
    idfExport: String(merged.idfExport || ""),
    projectDir: String(merged.projectDir || ""),
    firmwareDir: String(merged.firmwareDir || ""),
    skipBuildOnFlash: Boolean(merged.skipBuildOnFlash),
    autoPort: Boolean(merged.autoPort),
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
  const baudRate = Number(merged.baudRate);
  const frameGapMs = Number(merged.frameGapMs);
  const timedSendIntervalMs = Number(merged.timedSendIntervalMs);

  return {
    port: String(merged.port || "AUTO").trim().toUpperCase(),
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

function readDefaultConfig() {
  const examplePath = path.join(getEspToolDir(), "flash_tool.config.example.json");
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

  if (config.autoPort) {
    args.push("-AutoPort");
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
    const child = spawnPowerShell(script, getEspToolDir());
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

  if (!config.port || config.port === "AUTO") {
    const firstPort = ports[0]?.path;
    if (!firstPort) {
      throw new Error("未发现串口。请检查 USB-UART 转接器和驱动。");
    }
    return firstPort;
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
  toolDir: getEspToolDir(),
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
  const toolDir = getEspToolDir();
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
