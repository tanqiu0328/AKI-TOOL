import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  Cable,
  CheckCircle2,
  CircleDot,
  Copy,
  Cpu,
  Eraser,
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
  Terminal,
  Trash2,
  Wrench
} from "lucide-react";
import { getAkiApi } from "./bridge";
import type { ActionFinishedEvent, ActionOutputEvent, EspAction, EspConfig } from "./types";

const initialConfig: EspConfig = {
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

const chipOptions = ["esp32", "esp32s2", "esp32s3", "esp32c3", "esp32c6", "esp32h2"];
const baudOptions = [115200, 230400, 460800, 921600, 1500000];

const toolItems = [
  { id: "esp", name: "ESP 烧录", meta: "flash / monitor", icon: Cpu, active: true },
  { id: "serial", name: "串口日志", meta: "未开放", icon: Terminal, active: false },
  { id: "package", name: "固件包", meta: "未开放", icon: HardDriveDownload, active: false },
  { id: "settings", name: "全局设置", meta: "未开放", icon: Settings2, active: false }
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
type SetConfigField = <K extends keyof EspConfig>(key: K, value: EspConfig[K]) => void;

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function actionLabel(action: EspAction) {
  return actionItems.find((item) => item.action === action)?.label ?? action;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function Sidebar({
  portStateText,
  runStateClass,
  statusText
}: {
  portStateText: string;
  runStateClass: RunStateClass;
  statusText: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark">AK</div>
        <div className="brand-copy">
          <div className="brand-name">AKI-TOOL</div>
          <div className="brand-subtitle">ESP utility console</div>
        </div>
      </div>

      <nav className="tool-nav" aria-label="工具导航">
        {toolItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.id}
              className={`tool-nav-item ${item.active ? "active" : ""}`}
              disabled={!item.active}
              title={item.active ? item.name : `${item.name}暂未开放`}
            >
              <Icon size={19} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.meta}</small>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-summary" aria-label="工具概览">
        <div>
          <span>当前工具</span>
          <strong>ESP 烧录</strong>
        </div>
        <div>
          <span>串口检测</span>
          <strong>{portStateText}</strong>
        </div>
      </div>

      <div className="sidebar-footer">
        <div className={`state-dot ${runStateClass}`} />
        <span>{statusText}</span>
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
        <div className="eyebrow">ESP FLASHER</div>
        <h1>ESP 烧录工作台</h1>
        <p>配置、编译、烧录与串口日志集中操作</p>
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
  portStateText,
  statusText
}: {
  config: EspConfig;
  portStateText: string;
  statusText: string;
}) {
  const cards = [
    { label: "芯片型号", value: config.chip, icon: Cpu },
    { label: "目标串口", value: config.port || "AUTO", icon: Cable },
    { label: "串口检测", value: portStateText, icon: CircleDot },
    { label: "任务状态", value: statusText, icon: CheckCircle2 }
  ];

  return (
    <section className="status-strip" aria-label="当前状态">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div className="status-cell" key={card.label}>
            <Icon size={18} />
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        );
      })}
    </section>
  );
}

function ConfigPanel({
  config,
  configPath,
  onChooseDirectory,
  onChooseIdfExport,
  portOptions,
  setField
}: {
  config: EspConfig;
  configPath: string;
  onChooseDirectory: (key: "projectDir" | "firmwareDir") => void;
  onChooseIdfExport: () => void;
  portOptions: string[];
  setField: SetConfigField;
}) {
  return (
    <section className="panel config-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">CONFIGURATION</span>
          <h2>连接与固件</h2>
          <p>{configPath || "配置路径待加载"}</p>
        </div>
        <Wrench size={20} />
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
          <input
            list="port-options"
            value={config.port}
            onChange={(event) => setField("port", event.target.value.toUpperCase())}
          />
          <datalist id="port-options">
            {portOptions.map((port) => (
              <option key={port} value={port} />
            ))}
          </datalist>
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

      <div className="path-stack">
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
      </div>
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
  activeAction: EspAction | "";
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
          <span className="panel-kicker">RUN CENTER</span>
          <h2>执行控制</h2>
          <p>{toolDir || "后端路径待加载"}</p>
        </div>
        <Play size={20} />
      </div>

      <button type="button" className="launch-button" onClick={() => onRunAction(primaryAction.action)} disabled={isRunning}>
        <PrimaryIcon size={24} />
        <span>
          <strong>{activeAction === primaryAction.action ? "烧录中" : primaryAction.label}</strong>
          <small>{config.skipBuildOnFlash ? "跳过编译，直接烧录固件" : "编译后烧录固件"}</small>
        </span>
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
              disabled={isRunning}
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
          disabled={isRunning}
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
          <input type="checkbox" checked={config.autoPort} onChange={(event) => setField("autoPort", event.target.checked)} />
          <span>自动串口</span>
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
  activeAction: EspAction | "";
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
          <span className="panel-kicker">OUTPUT</span>
          <h2>日志</h2>
          <p>{isRunning ? `正在${actionLabel(activeAction as EspAction)}` : statusText}</p>
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
  const [activeAction, setActiveAction] = useState<EspAction | "">("");
  const [statusText, setStatusText] = useState("就绪");
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);

  const portOptions = useMemo(() => uniqueValues(["AUTO", config.port, ...ports]), [config.port, ports]);

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

  async function runAction(action: EspAction) {
    setLogText("");
    setLastExitCode(null);
    stopRequestedRef.current = false;
    setIsRunning(true);
    setActiveAction(action);
    setStatusText(`正在${actionLabel(action)}`);
    appendLog(`==> ${actionLabel(action)}\n`);

    try {
      await api.esp.runAction(action, config);
    } catch (error) {
      setIsRunning(false);
      setActiveAction("");
      setStatusText("启动失败");
      appendLog(`启动失败: ${getErrorMessage(error)}\n`);
    }
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
      <Sidebar portStateText={portStateText} runStateClass={runStateClass} statusText={statusText} />

      <main className="workspace">
        <WorkspaceHeader
          activeActionText={activeActionText}
          onRefreshPorts={refreshPorts}
          onSaveConfig={saveConfig}
          runStateClass={runStateClass}
        />

        <StatusCards config={config} portStateText={portStateText} statusText={statusText} />

        <div className="workspace-grid">
          <ConfigPanel
            config={config}
            configPath={configPath}
            onChooseDirectory={(key) => void chooseDirectory(key)}
            onChooseIdfExport={() => void chooseIdfExport()}
            portOptions={portOptions}
            setField={setField}
          />

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
    </div>
  );
}

export default App;
