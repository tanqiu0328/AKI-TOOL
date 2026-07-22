import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  Cable,
  CheckCircle2,
  Copy,
  Cpu,
  Eraser,
  FileText,
  Flame,
  FolderOpen,
  Hammer,
  HardDriveDownload,
  Play,
  Radio,
  RefreshCw,
  Save,
  SearchCheck,
  Settings2,
  Square,
  Trash2
} from "lucide-react";
import { getAkiApi } from "./bridge";
import { CustomFlashPanel } from "./CustomFlashPanel";
import { LowerBoardSimulator } from "./LowerBoardSimulator";
import type {
  ActionFinishedEvent,
  ActionOutputEvent,
  CustomFlashRequest,
  EspAction,
  EspConfig,
  ToolId
} from "./types";

const initialConfig: EspConfig = {
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

const chipOptions = ["esp32", "esp32s2", "esp32s3", "esp32c3", "esp32c6", "esp32h2"];
const baudOptions = [115200, 230400, 460800, 921600, 1500000];

const toolItems = [
  { id: "esp", name: "ESP 烧录", meta: "flash / monitor", icon: Cpu, enabled: true },
  { id: "lowerBoardSim", name: "下板模拟", meta: "lower board", icon: Cable, enabled: true },
  { id: "package", name: "固件包", meta: "未开放", icon: HardDriveDownload, enabled: false },
  { id: "settings", name: "全局设置", meta: "未开放", icon: Settings2, enabled: false }
];

const actionItems: Array<{
  action: EspAction;
  label: string;
  tone: "primary" | "default" | "danger";
  icon: typeof Play;
}> = [
  { action: "Doctor", label: "环境检查", tone: "default", icon: SearchCheck },
  { action: "Build", label: "编译", tone: "default", icon: Hammer },
  { action: "Flash", label: "烧录", tone: "primary", icon: Flame },
  { action: "Erase", label: "擦除", tone: "danger", icon: Eraser },
  { action: "Monitor", label: "串口监视", tone: "default", icon: Radio }
];

type RunStateClass = "running" | "ok" | "idle" | "error";
type EspFlashMode = "firmware" | "custom";
type ActiveEspOperation = EspAction | "CustomFlash";
type SetConfigField = <K extends keyof EspConfig>(key: K, value: EspConfig[K]) => void;

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function actionLabel(action: ActiveEspOperation) {
  if (action === "CustomFlash") {
    return "自定义烧录";
  }

  return actionItems.find((item) => item.action === action)?.label ?? action;
}

function actionNeedsPort(action: EspAction) {
  return action === "Flash" || action === "Erase" || action === "Monitor";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactPath(path: string) {
  if (!path) {
    return "待加载";
  }

  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function countLogLines(logText: string) {
  const trimmed = logText.trim();
  return trimmed ? String(trimmed.split(/\r?\n/).length) : "0";
}

function Sidebar({
  activeTool,
  onSelectTool,
  portStateText,
  runStateClass,
  statusText
}: {
  activeTool: ToolId;
  onSelectTool: (tool: ToolId) => void;
  portStateText: string;
  runStateClass: RunStateClass;
  statusText: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-mark" title="AKI-TOOL">AK</div>

      <nav className="tool-nav" aria-label="工具导航">
        {toolItems.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeTool;
          return (
            <button
              type="button"
              key={item.id}
              className={`tool-nav-item ${isActive ? "active" : ""}`}
              disabled={!item.enabled}
              onClick={() => item.enabled && onSelectTool(item.id as ToolId)}
              title={item.enabled ? item.name : `${item.name}暂未开放`}
            >
              <Icon size={19} />
              <span className="sr-only">{item.name}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer" title={`${statusText} · ${portStateText}`}>
        <div className={`state-dot ${runStateClass}`} />
        <span className="sr-only">{statusText}</span>
      </div>
    </aside>
  );
}

function WorkspaceHeader({
  activeActionText,
  onRefreshPorts,
  onSaveConfig,
  runStateClass
}: {
  activeActionText: string;
  onRefreshPorts: () => void;
  onSaveConfig: () => void;
  runStateClass: RunStateClass;
}) {
  return (
    <header className="workspace-header">
      <div className="title-block">
        <h1>仪表盘</h1>
        <p>ESP 烧录、串口调试与运行日志</p>
      </div>
      <div className="header-cluster">
        <div className={`run-indicator ${runStateClass}`} aria-label="当前任务状态">
          <span />
          <strong>{activeActionText}</strong>
        </div>
        <button type="button" className="icon-button" onClick={onRefreshPorts} title="刷新串口">
          <RefreshCw size={18} />
        </button>
        <button type="button" className="command-button" onClick={onSaveConfig}>
          <Save size={18} />
          保存配置
        </button>
      </div>
    </header>
  );
}

function StatusCards({
  config,
  configPath,
  logText,
  portStateText,
  statusText
}: {
  config: EspConfig;
  configPath: string;
  logText: string;
  portStateText: string;
  statusText: string;
}) {
  const cards = [
    { label: "串口状态", value: config.port || "未选择", hint: portStateText, icon: Cable, tone: "" },
    { label: "当前芯片", value: config.chip, icon: Cpu, tone: "cyan" },
    { label: "任务状态", value: statusText, icon: CheckCircle2, tone: "green" },
    { label: "配置路径", value: compactPath(configPath), icon: FolderOpen, tone: "amber" },
    { label: "日志计数", value: countLogLines(logText), hint: "行", icon: FileText, tone: "violet" }
  ];

  return (
    <section className="status-strip" aria-label="当前状态">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div className="status-cell" key={card.label}>
            <Icon className={card.tone} size={18} />
            <span>{card.label}</span>
            <strong title={card.value}>{card.value}</strong>
            {card.hint ? <small>{card.hint}</small> : null}
          </div>
        );
      })}
    </section>
  );
}

function ConfigPanel({
  config,
  configPath,
  flashMode,
  onChooseDirectory,
  onChooseIdfExport,
  portOptions,
  setField
}: {
  config: EspConfig;
  configPath: string;
  flashMode: EspFlashMode;
  onChooseDirectory: (key: "projectDir" | "firmwareDir") => void;
  onChooseIdfExport: () => void;
  portOptions: string[];
  setField: SetConfigField;
}) {
  return (
    <section className="panel config-panel">
      <div className="panel-heading">
        <div>
          <h2>{flashMode === "firmware" ? "连接与固件" : "连接设置"}</h2>
          <p>{configPath || "配置路径待加载"}</p>
        </div>
        <Settings2 size={20} />
      </div>

      <div className="form-grid compact">
        <label className="field">
          <span>芯片型号</span>
          <select value={config.chip} onChange={(event) => setField("chip", event.target.value)}>
            {chipOptions.map((chip) => (
              <option key={chip} value={chip}>
                {chip}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>串口</span>
          <select value={config.port} onChange={(event) => setField("port", event.target.value)}>
            <option value="">请选择串口</option>
            {portOptions.map((port) => (
              <option key={port} value={port}>
                {port}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>烧录波特率</span>
          <select value={config.baud} onChange={(event) => setField("baud", Number(event.target.value))}>
            {baudOptions.map((baud) => (
              <option key={baud} value={baud}>
                {baud}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>监视波特率</span>
          <input
            type="number"
            min={9600}
            max={2000000}
            value={config.monitorBaud}
            onChange={(event) => setField("monitorBaud", Number(event.target.value))}
          />
        </label>
      </div>

      {flashMode === "firmware" ? <div className="path-stack">
        <label className="field path-field">
          <span>ESP-IDF export</span>
          <div className="path-control">
            <input value={config.idfExport} onChange={(event) => setField("idfExport", event.target.value)} />
            <button type="button" className="icon-button" onClick={onChooseIdfExport} title="选择 export.bat">
              <FolderOpen size={18} />
            </button>
          </div>
        </label>

        <label className="field path-field">
          <span>项目目录</span>
          <div className="path-control">
            <input value={config.projectDir} onChange={(event) => setField("projectDir", event.target.value)} />
            <button
              type="button"
              className="icon-button"
              onClick={() => onChooseDirectory("projectDir")}
              title="选择项目目录"
            >
              <FolderOpen size={18} />
            </button>
          </div>
        </label>

        <label className="field path-field">
          <span>固件目录</span>
          <div className="path-control">
            <input value={config.firmwareDir} onChange={(event) => setField("firmwareDir", event.target.value)} />
            <button
              type="button"
              className="icon-button"
              onClick={() => onChooseDirectory("firmwareDir")}
              title="选择固件目录"
            >
              <FolderOpen size={18} />
            </button>
          </div>
        </label>
      </div> : null}
    </section>
  );
}

function ActionPanel({
  activeAction,
  config,
  isRunning,
  onOpenQuickPath,
  onRunAction,
  onStopAction,
  setField,
  toolDir,
  userDataDir
}: {
  activeAction: ActiveEspOperation | "";
  config: EspConfig;
  isRunning: boolean;
  onOpenQuickPath: (targetPath: string, label: string) => void;
  onRunAction: (action: EspAction) => void;
  onStopAction: () => void;
  setField: SetConfigField;
  toolDir: string;
  userDataDir: string;
}) {
  const primaryAction = actionItems.find((item) => item.action === "Flash") ?? actionItems[0];
  const secondaryActions = actionItems.filter((item) => ["Doctor", "Build", "Monitor"].includes(item.action));
  const eraseAction = actionItems.find((item) => item.action === "Erase") ?? actionItems[0];
  const PrimaryIcon = primaryAction.icon;
  const EraseIcon = eraseAction.icon;

  return (
    <section className="panel action-panel">
      <div className="panel-heading">
        <div>
          <h2>执行控制</h2>
          <p>{toolDir || "后端路径待加载"}</p>
        </div>
        <Play size={20} />
      </div>

      <button
        type="button"
        className="launch-button"
        onClick={() => onRunAction(primaryAction.action)}
        disabled={isRunning || (actionNeedsPort(primaryAction.action) && !config.port)}
      >
        <PrimaryIcon size={24} />
        <span>
          <strong>{activeAction === primaryAction.action ? "烧录中" : "烧录固件"}</strong>
          <small>{config.skipBuildOnFlash ? "跳过编译，直接烧录固件" : "编译后烧录固件"}</small>
        </span>
        <Play size={18} />
      </button>

      <div className="action-grid">
        {secondaryActions.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.action}
              className={`action-button ${item.tone}`}
              onClick={() => onRunAction(item.action)}
              disabled={isRunning || (actionNeedsPort(item.action) && !config.port)}
            >
              <Icon size={18} />
              {activeAction === item.action ? "执行中" : item.label}
            </button>
          );
        })}
      </div>

      <div className="danger-row">
        <button
          type="button"
          className="action-button danger"
          onClick={() => onRunAction(eraseAction.action)}
          disabled={isRunning || (actionNeedsPort(eraseAction.action) && !config.port)}
        >
          <EraseIcon size={18} />
          {activeAction === eraseAction.action ? "执行中" : eraseAction.label}
        </button>
        <button type="button" className="action-button stop" onClick={onStopAction} disabled={!isRunning}>
          <Square size={18} />
          停止
        </button>
      </div>

      <div className="toggle-grid">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={config.skipBuildOnFlash}
            onChange={(event) => setField("skipBuildOnFlash", event.target.checked)}
          />
          <span>烧录时不编译</span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={config.manualDownloadMode}
            onChange={(event) => setField("manualDownloadMode", event.target.checked)}
          />
          <span>手动下载模式</span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={config.openMonitorAfterFlash}
            onChange={(event) => setField("openMonitorAfterFlash", event.target.checked)}
          />
          <span>烧录后监视</span>
        </label>
      </div>

      <div className="quick-paths">
        <button type="button" onClick={() => onOpenQuickPath(userDataDir, "用户数据")} disabled={!userDataDir}>
          <FolderOpen size={16} />
          用户数据
        </button>
        <button type="button" onClick={() => onOpenQuickPath(toolDir, "后端目录")} disabled={!toolDir}>
          <FolderOpen size={16} />
          后端目录
        </button>
      </div>
    </section>
  );
}

function LogPanel({
  activeAction,
  isRunning,
  logText,
  onClearLog,
  onCopyLog,
  statusText,
  terminalRef
}: {
  activeAction: ActiveEspOperation | "";
  isRunning: boolean;
  logText: string;
  onClearLog: () => void;
  onCopyLog: () => void;
  statusText: string;
  terminalRef: RefObject<HTMLPreElement>;
}) {
  return (
    <section className="panel log-panel">
      <div className="terminal-toolbar">
        <div>
          <h2>运行日志</h2>
          <p>{isRunning ? `正在${actionLabel(activeAction as ActiveEspOperation)}` : statusText}</p>
        </div>
        <div className="terminal-actions">
          <button type="button" className="icon-button" onClick={onCopyLog} title="复制日志">
            <Copy size={18} />
          </button>
          <button type="button" className="icon-button" onClick={onClearLog} title="清空日志">
            <Trash2 size={18} />
          </button>
        </div>
      </div>
      <pre ref={terminalRef} className="terminal-output">
        {logText}
      </pre>
    </section>
  );
}

function App() {
  const api = useMemo(() => getAkiApi(), []);
  const isDesktop = useMemo(() => Boolean(window.aki), []);
  const terminalRef = useRef<HTMLPreElement>(null);
  const stopRequestedRef = useRef(false);

  const [config, setConfig] = useState<EspConfig>(initialConfig);
  const [ports, setPorts] = useState<string[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [toolDir, setToolDir] = useState("");
  const [userDataDir, setUserDataDir] = useState("");
  const [logText, setLogText] = useState("就绪。\n");
  const [isRunning, setIsRunning] = useState(false);
  const [activeAction, setActiveAction] = useState<ActiveEspOperation | "">("");
  const [statusText, setStatusText] = useState("就绪");
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId>("esp");
  const [flashMode, setFlashMode] = useState<EspFlashMode>("firmware");

  const portOptions = useMemo(() => uniqueValues([config.port, ...ports]), [config.port, ports]);

  const setField = useCallback(<K extends keyof EspConfig>(key: K, value: EspConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const appendLog = useCallback((text: string) => {
    setLogText((current) => `${current}${text}`.slice(-50000));
  }, []);

  const refreshPorts = useCallback(async () => {
    setStatusText("正在刷新串口");
    try {
      const nextPorts = await api.esp.listPorts();
      const nextStatusText = nextPorts.length > 0 ? `发现 ${nextPorts.length} 个串口` : "未发现串口";
      setPorts(nextPorts);
      setStatusText(nextStatusText);
      appendLog(`串口刷新: ${nextStatusText}。\n`);
    } catch (error) {
      setPorts([]);
      setStatusText("串口刷新失败");
      appendLog(`串口刷新失败: ${getErrorMessage(error)}\n`);
    }
  }, [api, appendLog]);

  const loadConfig = useCallback(async () => {
    try {
      const payload = await api.esp.getConfig();
      setConfig(payload.config);
      setConfigPath(payload.configPath);
      setToolDir(payload.toolDir);
      setUserDataDir(payload.userDataDir);
    } catch (error) {
      setStatusText("配置加载失败");
      appendLog(`配置加载失败: ${getErrorMessage(error)}\n`);
    }
  }, [api, appendLog]);

  useEffect(() => {
    void loadConfig();
    void refreshPorts();
  }, [loadConfig, refreshPorts]);

  useEffect(() => {
    const offOutput = api.esp.onActionOutput((event: ActionOutputEvent) => {
      appendLog(event.text);
    });

    const offFinished = api.esp.onActionFinished((event: ActionFinishedEvent) => {
      const wasStopRequested = stopRequestedRef.current;
      stopRequestedRef.current = false;
      setIsRunning(false);
      setActiveAction("");
      setLastExitCode(event.exitCode);
      setStatusText(wasStopRequested ? "已停止" : event.exitCode === 0 ? "执行完成" : "执行失败");
      appendLog(
        wasStopRequested
          ? `\n任务已停止，退出码 ${event.exitCode ?? event.signal ?? "unknown"}。\n`
          : `\n进程已退出，退出码 ${event.exitCode ?? event.signal ?? "unknown"}。\n`
      );
    });

    return () => {
      offOutput();
      offFinished();
    };
  }, [api, appendLog]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logText]);

  async function saveConfig() {
    setStatusText("正在保存配置");
    try {
      const payload = await api.esp.saveConfig(config);
      setConfig(payload.config);
      setConfigPath(payload.configPath);
      setStatusText("配置已保存");
    } catch (error) {
      setStatusText("配置保存失败");
      appendLog(`配置保存失败: ${getErrorMessage(error)}\n`);
    }
  }

  async function startEspOperation(
    operation: ActiveEspOperation,
    label: string,
    initialLog: string,
    start: () => Promise<{ id: string }>
  ) {
    setLogText(initialLog);
    setLastExitCode(null);
    stopRequestedRef.current = false;
    setIsRunning(true);
    setActiveAction(operation);
    setStatusText(`正在${label}`);

    try {
      await start();
    } catch (error) {
      setIsRunning(false);
      setActiveAction("");
      setStatusText("启动失败");
      appendLog(`启动失败: ${getErrorMessage(error)}\n`);
    }
  }

  async function runAction(action: EspAction) {
    if (actionNeedsPort(action) && !config.port) {
      setStatusText("请先选择串口");
      appendLog(`${actionLabel(action)}需要先选择串口。\n`);
      return;
    }

    const label = actionLabel(action);
    await startEspOperation(action, label, `==> ${label}\n`, () => api.esp.runAction(action, config));
  }

  async function runCustomFlash(request: CustomFlashRequest) {
    await startEspOperation(
      "CustomFlash",
      "自定义烧录",
      `==> 自定义烧录\n自定义烧录项: ${request.item.name}\n`,
      () => api.esp.runCustomFlash(request)
    );
  }

  async function stopAction() {
    setStatusText("停止中");
    try {
      const stopped = await api.esp.stopAction();
      stopRequestedRef.current = stopped;
      setStatusText(stopped ? "停止中" : "没有运行中的任务");
    } catch (error) {
      stopRequestedRef.current = false;
      setStatusText("停止失败");
      appendLog(`停止失败: ${getErrorMessage(error)}\n`);
    }
  }

  async function chooseDirectory(key: "projectDir" | "firmwareDir") {
    const label = key === "projectDir" ? "项目目录" : "固件目录";
    setStatusText(`选择${label}`);
    try {
      const selected = await api.dialog.selectDirectory();
      if (selected) {
        setField(key, selected);
        setStatusText(`${label}已选择`);
        return;
      }

      if (isDesktop) {
        setStatusText("已取消选择");
      } else {
        setStatusText("预览模式不支持选目录");
        appendLog("浏览器预览模式不支持选择本机目录，请运行 AKI-TOOL 桌面版。\n");
      }
    } catch (error) {
      setStatusText(`${label}选择失败`);
      appendLog(`${label}选择失败: ${getErrorMessage(error)}\n`);
    }
  }

  async function chooseIdfExport() {
    setStatusText("选择 ESP-IDF export");
    try {
      const selected = await api.dialog.selectFile({
        title: "选择 ESP-IDF export.bat",
        filters: [
          { name: "export.bat", extensions: ["bat"] },
          { name: "批处理文件", extensions: ["bat", "cmd"] },
          { name: "所有文件", extensions: ["*"] }
        ]
      });
      if (selected) {
        setField("idfExport", selected);
        setStatusText("ESP-IDF export 已选择");
        return;
      }

      if (isDesktop) {
        setStatusText("已取消选择");
      } else {
        setStatusText("预览模式不支持选文件");
        appendLog("浏览器预览模式不支持选择本机文件，请运行 AKI-TOOL 桌面版。\n");
      }
    } catch (error) {
      setStatusText("export 选择失败");
      appendLog(`export 选择失败: ${getErrorMessage(error)}\n`);
    }
  }

  async function copyLog() {
    if (!logText.trim()) {
      setStatusText("没有可复制日志");
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("当前环境不支持剪贴板写入。");
      }

      await navigator.clipboard.writeText(logText);
      setStatusText("日志已复制");
    } catch (error) {
      setStatusText("日志复制失败");
      appendLog(`日志复制失败: ${getErrorMessage(error)}\n`);
    }
  }

  function clearLog() {
    setLogText("");
    setStatusText("日志已清空");
  }

  async function openQuickPath(targetPath: string, label: string) {
    if (!targetPath) {
      setStatusText(`${label}未加载`);
      return;
    }

    if (!isDesktop) {
      setStatusText("预览模式不支持打开目录");
      appendLog("浏览器预览模式不支持打开本机目录，请运行 AKI-TOOL 桌面版。\n");
      return;
    }

    setStatusText(`打开${label}`);
    try {
      const result = await api.shell.openPath(targetPath);
      if (result) {
        setStatusText(`${label}打开失败`);
        appendLog(`${label}打开失败: ${result}\n`);
        return;
      }

      setStatusText(`已打开${label}`);
    } catch (error) {
      setStatusText(`${label}打开失败`);
      appendLog(`${label}打开失败: ${getErrorMessage(error)}\n`);
    }
  }

  const portStateText = ports.length > 0 ? `${ports.length} 个串口` : "未发现";
  const runStateClass: RunStateClass = isRunning
    ? "running"
    : lastExitCode === 0
      ? "ok"
      : lastExitCode === null
        ? "idle"
        : "error";
  const activeActionText = activeAction ? actionLabel(activeAction) : statusText;

  return (
    <div className="app-shell">
      <Sidebar
        activeTool={activeTool}
        onSelectTool={setActiveTool}
        portStateText={portStateText}
        runStateClass={runStateClass}
        statusText={statusText}
      />

      {activeTool === "lowerBoardSim" ? (
        <LowerBoardSimulator api={api} />
      ) : (
        <main className="workspace">
          <WorkspaceHeader
            activeActionText={activeActionText}
            onRefreshPorts={refreshPorts}
            onSaveConfig={saveConfig}
            runStateClass={runStateClass}
          />

          <StatusCards
            config={config}
            configPath={configPath}
            logText={logText}
            portStateText={portStateText}
            statusText={statusText}
          />

          <div className="flash-mode-switch" role="group" aria-label="烧录模式">
            <button
              type="button"
              className={flashMode === "firmware" ? "active" : ""}
              onClick={() => setFlashMode("firmware")}
              disabled={isRunning}
            >
              固件烧录
            </button>
            <button
              type="button"
              className={flashMode === "custom" ? "active" : ""}
              onClick={() => setFlashMode("custom")}
              disabled={isRunning}
            >
              自定义烧录
            </button>
          </div>

          <div className="workspace-grid">
            <ConfigPanel
              config={config}
              configPath={configPath}
              flashMode={flashMode}
              onChooseDirectory={(key) => void chooseDirectory(key)}
              onChooseIdfExport={() => void chooseIdfExport()}
              portOptions={portOptions}
              setField={setField}
            />

            {flashMode === "firmware" ? (
              <ActionPanel
                activeAction={activeAction}
                config={config}
                isRunning={isRunning}
                onOpenQuickPath={(targetPath, label) => void openQuickPath(targetPath, label)}
                onRunAction={(action) => void runAction(action)}
                onStopAction={() => void stopAction()}
                setField={setField}
                toolDir={toolDir}
                userDataDir={userDataDir}
              />
            ) : (
              <CustomFlashPanel
                api={api}
                config={config}
                isRunning={isRunning}
                onRun={(request) => void runCustomFlash(request)}
                onStatus={setStatusText}
                onStop={() => void stopAction()}
              />
            )}

            <LogPanel
              activeAction={activeAction}
              isRunning={isRunning}
              logText={logText}
              onClearLog={clearLog}
              onCopyLog={() => void copyLog()}
              statusText={statusText}
              terminalRef={terminalRef}
            />
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
