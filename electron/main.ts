import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";
import {
  createLowerBoardSimulationSession,
  defaultLowerBoardSimConfig,
  type LowerBoardSimAdapter,
  type LowerBoardSimConfig,
  type LowerBoardSimulationStorage
} from "../shared/lowerBoardSimulation.js";
import {
  removeCustomFlashPlan,
  upsertCustomFlashPlan,
  validateCustomFlashItems,
  validateCustomFlashPlan
} from "../shared/customFlash.js";
import type { CustomFlashPlan, CustomFlashRequest, EspAction, EspConfig } from "../shared/espToolContract.cjs";
import {
  createElectronLowerBoardSimAdapter,
  createSerialPortLowerBoardSimulationTransport
} from "./lowerBoardSimAdapter.js";

type RunningAction = {
  id: string;
  process: ChildProcessWithoutNullStreams;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let runningAction: RunningAction | null = null;
let lowerBoardSimAdapter: LowerBoardSimAdapter | undefined;

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

function getLowerBoardSimConfigPath() {
  return path.join(app.getPath("userData"), "lower-board-sim.config.json");
}

function getCustomFlashPlansPath() {
  return path.join(app.getPath("userData"), "custom-flash-plans.json");
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

function readCustomFlashPlans() {
  const storedPlans = readJsonFile<unknown>(getCustomFlashPlansPath(), []);
  if (!Array.isArray(storedPlans)) {
    return [];
  }

  return storedPlans.flatMap((plan) => {
    try {
      return [validateCustomFlashPlan(plan as CustomFlashPlan)];
    } catch {
      return [];
    }
  });
}

function writeCustomFlashPlans(plans: CustomFlashPlan[]) {
  const plansPath = getCustomFlashPlansPath();
  fs.mkdirSync(path.dirname(plansPath), { recursive: true });
  fs.writeFileSync(plansPath, JSON.stringify(plans, null, 2), "utf8");
}

function saveCustomFlashPlan(plan: CustomFlashPlan) {
  const { plans, savedPlan } = upsertCustomFlashPlan(readCustomFlashPlans(), plan);
  writeCustomFlashPlans(plans);
  return savedPlan;
}

function deleteCustomFlashPlan(planId: string) {
  const result = removeCustomFlashPlan(readCustomFlashPlans(), planId);
  if (!result.deleted) {
    return false;
  }
  writeCustomFlashPlans(result.plans);
  return true;
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

function getCustomFlashRunArgs(request: CustomFlashRequest) {
  const items = validateCustomFlashItems(request.items);
  return [
    "-Action",
    "CustomFlash",
    "-Config",
    getUserConfigPath(),
    "-NoPause",
    "-Chip",
    request.config.chip,
    "-Port",
    request.config.port,
    "-Baud",
    String(request.config.baud),
    "-CustomFlashItemsJson",
    JSON.stringify(items.map(({ name, filePath, address, expectedFileSize }) => ({
      name,
      filePath,
      address,
      expectedFileSize
    })))
  ];
}

function inspectCustomFlashFile(filePath: string) {
  const normalizedPath = path.resolve(String(filePath || ""));

  try {
    const stats = fs.statSync(normalizedPath);
    return {
      filePath: normalizedPath,
      fileName: path.basename(normalizedPath),
      size: stats.isFile() ? stats.size : 0,
      exists: stats.isFile()
    };
  } catch {
    return {
      filePath: normalizedPath,
      fileName: path.basename(normalizedPath),
      size: 0,
      exists: false
    };
  }
}

function validateCustomFlashRequest(request: CustomFlashRequest) {
  const items = validateCustomFlashItems(request.items);
  for (const item of items) {
    const inspection = inspectCustomFlashFile(item.filePath);
    if (!inspection.exists) {
      throw new Error(`自定义烧录项“${item.name}”的文件不存在: ${item.filePath}`);
    }
    if (inspection.size !== item.expectedFileSize) {
      throw new Error(
        `自定义烧录项“${item.name}”的文件大小已变化: 确认时 ${item.expectedFileSize} 字节，当前 ${inspection.size} 字节`
      );
    }
  }
  if (!request.config.port) {
    throw new Error("请先选择 ESP 串口。");
  }
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

function createLowerBoardSimStorage(): LowerBoardSimulationStorage {
  const configPath = getLowerBoardSimConfigPath();

  function ensureConfigFile() {
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(defaultLowerBoardSimConfig, null, 2), "utf8");
    }
  }

  return {
    async load() {
      ensureConfigFile();
      return readJsonFile<Partial<LowerBoardSimConfig>>(configPath, defaultLowerBoardSimConfig);
    },
    async save(config) {
      ensureConfigFile();
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    }
  };
}

async function resolveLowerBoardSimPortPath(requestedPort: string) {
  const ports = await listSerialPorts();
  if (!requestedPort) {
    throw new Error("请先选择 USB-TTL 串口");
  }

  const matchedPort = ports.find((port) => port.path.toUpperCase() === requestedPort.toUpperCase());
  if (!matchedPort) {
    const portText = ports.length > 0 ? ports.map((port) => port.path).join(", ") : "无";
    throw new Error(`未找到串口 ${requestedPort}。当前串口: ${portText}`);
  }

  return matchedPort.path;
}

function getLowerBoardSimAdapter() {
  if (lowerBoardSimAdapter) {
    return lowerBoardSimAdapter;
  }

  const transport = createSerialPortLowerBoardSimulationTransport({
    resolvePort: resolveLowerBoardSimPortPath,
    createPort: (options) => new SerialPort(options)
  });
  const session = createLowerBoardSimulationSession({
    transport,
    storage: createLowerBoardSimStorage(),
    clock: {
      now: Date.now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    random: {
      next: Math.random
    }
  });

  lowerBoardSimAdapter = createElectronLowerBoardSimAdapter({
    session,
    configPath: getLowerBoardSimConfigPath(),
    listPorts: listSerialPorts
  });
  lowerBoardSimAdapter.onStatus((event) => {
    mainWindow?.webContents.send("lower-board-sim:status", event);
  });
  lowerBoardSimAdapter.onFrame((event) => {
    mainWindow?.webContents.send("lower-board-sim:frame", event);
  });

  return lowerBoardSimAdapter;
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

function ensureNoRunningAction() {
  if (runningAction && !runningAction.process.killed) {
    throw new Error("已有任务正在执行。");
  }
}

function startEspProcess(args: string[]) {
  const actionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const toolDir = getRunnableEspToolDir();
  const scriptPath = path.join(toolDir, "esp_flash_tool.ps1");
  const command = buildPowerShellInvocation(scriptPath, args);
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

ipcMain.handle("esp:inspect-custom-flash-file", (_event, filePath: string) => inspectCustomFlashFile(filePath));

ipcMain.handle("esp:list-custom-flash-plans", () => readCustomFlashPlans());

ipcMain.handle("esp:save-custom-flash-plan", (_event, plan: CustomFlashPlan) => saveCustomFlashPlan(plan));

ipcMain.handle("esp:delete-custom-flash-plan", (_event, planId: string) => deleteCustomFlashPlan(planId));

ipcMain.handle("esp:run-action", (_event, payload: { action: EspAction; config: Partial<EspConfig> }) => {
  ensureNoRunningAction();
  const config = writeUserConfig(payload.config);
  if (["Flash", "Erase", "Monitor"].includes(payload.action) && !config.port) {
    throw new Error("请先选择 ESP 串口。");
  }
  return startEspProcess(getRunArgs(payload.action, config));
});

ipcMain.handle("esp:run-custom-flash", (_event, payload: CustomFlashRequest) => {
  ensureNoRunningAction();
  const config = writeUserConfig(payload.config);
  const request = { ...payload, config };
  validateCustomFlashRequest(request);
  return startEspProcess(getCustomFlashRunArgs(request));
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

ipcMain.handle("lower-board-sim:get-config", () => getLowerBoardSimAdapter().getConfig());

ipcMain.handle("lower-board-sim:save-config", (_event, config: LowerBoardSimConfig) =>
  getLowerBoardSimAdapter().saveConfig(config)
);

ipcMain.handle("lower-board-sim:list-ports", () => getLowerBoardSimAdapter().listPorts());

ipcMain.handle("lower-board-sim:start", (_event, config: LowerBoardSimConfig) =>
  getLowerBoardSimAdapter().start(config)
);

ipcMain.handle("lower-board-sim:stop", () => getLowerBoardSimAdapter().stop());

ipcMain.handle("lower-board-sim:update-config", (_event, config: LowerBoardSimConfig) =>
  getLowerBoardSimAdapter().updateConfig(config)
);

ipcMain.handle("lower-board-sim:reset-stats", () => getLowerBoardSimAdapter().resetStats());

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
