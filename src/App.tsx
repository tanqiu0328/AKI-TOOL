import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function actionLabel(action: EspAction) {
  return actionItems.find((item) => item.action === action)?.label ?? action;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const api = useMemo(() => getAkiApi(), []);
  const isDesktop = useMemo(() => Boolean(window.aki), []);
  const terminalRef = useRef<HTMLPreElement | null>(null);
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
      setPorts(nextPorts);
      setStatusText(nextPorts.length > 0 ? `发现 ${nextPorts.length} 个串口` : "未发现串口");
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
  const runStateClass = isRunning ? "running" : lastExitCode === 0 ? "ok" : lastExitCode === null ? "idle" : "error";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">AK</div>
          <div>
            <div className="brand-name">AKI-TOOL</div>
            <div className="brand-subtitle">desktop utility suite</div>
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
                <Icon size={18} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.meta}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className={`state-dot ${runStateClass}`} />
          <span>{statusText}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <div className="eyebrow">ESP FLASHER</div>
            <h1>ESP 烧录工作台</h1>
          </div>
          <div className="header-actions">
            <button type="button" className="icon-button" onClick={refreshPorts} title="刷新串口">
              <RefreshCw size={18} />
            </button>
            <button type="button" className="command-button" onClick={saveConfig}>
              <Save size={18} />
              保存配置
            </button>
          </div>
        </header>

        <section className="status-strip" aria-label="当前状态">
          <div className="status-cell">
            <Cpu size={18} />
            <span>芯片</span>
            <strong>{config.chip}</strong>
          </div>
          <div className="status-cell">
            <Cable size={18} />
            <span>串口</span>
            <strong>{config.port || "AUTO"}</strong>
          </div>
          <div className="status-cell">
            <CircleDot size={18} />
            <span>检测</span>
            <strong>{portStateText}</strong>
          </div>
          <div className="status-cell">
            <CheckCircle2 size={18} />
            <span>任务</span>
            <strong>{statusText}</strong>
          </div>
        </section>

        <div className="workspace-grid">
          <section className="panel config-panel">
            <div className="panel-heading">
              <div>
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
                  <button type="button" className="icon-button" onClick={chooseIdfExport} title="选择 export.bat">
                    <FolderOpen size={18} />
                  </button>
                </div>
              </label>

              <label className="field path-field">
                <span>项目目录</span>
                <div className="path-control">
                  <input value={config.projectDir} onChange={(event) => setField("projectDir", event.target.value)} />
                  <button type="button" className="icon-button" onClick={() => chooseDirectory("projectDir")} title="选择项目目录">
                    <FolderOpen size={18} />
                  </button>
                </div>
              </label>

              <label className="field path-field">
                <span>固件目录</span>
                <div className="path-control">
                  <input value={config.firmwareDir} onChange={(event) => setField("firmwareDir", event.target.value)} />
                  <button type="button" className="icon-button" onClick={() => chooseDirectory("firmwareDir")} title="选择固件目录">
                    <FolderOpen size={18} />
                  </button>
                </div>
              </label>
            </div>
          </section>

          <section className="panel action-panel">
            <div className="panel-heading">
              <div>
                <h2>执行</h2>
                <p>{toolDir || "后端路径待加载"}</p>
              </div>
              <Play size={20} />
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
                  checked={config.autoPort}
                  onChange={(event) => setField("autoPort", event.target.checked)}
                />
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

            <div className="action-grid">
              {actionItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.action}
                    className={`action-button ${item.tone}`}
                    onClick={() => runAction(item.action)}
                    disabled={isRunning}
                  >
                    <Icon size={18} />
                    {activeAction === item.action ? "执行中" : item.label}
                  </button>
                );
              })}
              <button type="button" className="action-button stop" onClick={stopAction} disabled={!isRunning}>
                <Square size={18} />
                停止
              </button>
            </div>

            <div className="quick-paths">
              <button type="button" onClick={() => void openQuickPath(userDataDir, "用户数据")} disabled={!userDataDir}>
                <FolderOpen size={16} />
                用户数据
              </button>
              <button type="button" onClick={() => void openQuickPath(toolDir, "后端目录")} disabled={!toolDir}>
                <FolderOpen size={16} />
                后端目录
              </button>
            </div>
          </section>

          <section className="panel log-panel">
            <div className="terminal-toolbar">
              <div>
                <h2>日志</h2>
                <p>{isRunning ? `正在${actionLabel(activeAction as EspAction)}` : statusText}</p>
              </div>
              <div className="terminal-actions">
                <button type="button" className="icon-button" onClick={copyLog} title="复制日志">
                  <Copy size={18} />
                </button>
                <button type="button" className="icon-button" onClick={clearLog} title="清空日志">
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
            <pre ref={terminalRef} className="terminal-output">
              {logText}
            </pre>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
