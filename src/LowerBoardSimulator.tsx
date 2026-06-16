import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Cable,
  Gauge,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Trash2,
  Zap
} from "lucide-react";
import type {
  AkiApi,
  LowerBoardSimConfig,
  LowerBoardSimFrameEvent,
  LowerBoardSimStats,
  SerialPortInfo
} from "./types";

const initialConfig: LowerBoardSimConfig = {
  port: "AUTO",
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

const emptyStats: LowerBoardSimStats = {
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

type LowerBoardSimulatorProps = {
  api: AkiApi;
};

type SetConfigField = <K extends keyof LowerBoardSimConfig>(key: K, value: LowerBoardSimConfig[K]) => void;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function formatHexWord(value: number) {
  return `0x${Math.max(0, Math.min(0xffff, Math.round(value))).toString(16).padStart(4, "0").toUpperCase()}`;
}

function uniquePortOptions(configPort: string, ports: SerialPortInfo[]) {
  const values = ["AUTO", configPort, ...ports.map((port) => port.path)].filter(Boolean);
  return Array.from(new Set(values));
}

function formatFrameLine(event: LowerBoardSimFrameEvent) {
  const direction = event.direction.toUpperCase();
  const type = event.frameType === "command" ? "CMD" : event.frameType === "status" ? "STS" : "ERR";
  const frameText = event.hex ? ` ${event.hex}` : "";
  return `[${formatTimestamp(event.timestamp)}] ${direction} ${type}${frameText} | ${event.message}\n`;
}

function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="sim-stat-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function LowerBoardSimulator({ api }: LowerBoardSimulatorProps) {
  const configRef = useRef(initialConfig);
  const runningRef = useRef(false);

  const [config, setConfig] = useState<LowerBoardSimConfig>(initialConfig);
  const [configPath, setConfigPath] = useState("");
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState("就绪");
  const [stats, setStats] = useState<LowerBoardSimStats>(emptyStats);
  const [frameLog, setFrameLog] = useState("");

  const portOptions = useMemo(() => uniquePortOptions(config.port, ports), [config.port, ports]);
  const lastCommand = stats.lastCommand;
  const lastStatus = stats.lastStatus;

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const setField = useCallback<SetConfigField>((key, value) => {
    setConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const appendFrameLog = useCallback((event: LowerBoardSimFrameEvent) => {
    setFrameLog((current) => `${current}${formatFrameLine(event)}`.slice(-120000));
  }, []);

  const refreshPorts = useCallback(async () => {
    setStatusText("正在刷新串口");
    try {
      const nextPorts = await api.lowerBoardSim.listPorts();
      setPorts(nextPorts);
      setStatusText(nextPorts.length > 0 ? `发现 ${nextPorts.length} 个串口` : "未发现串口");
    } catch (error) {
      setPorts([]);
      setStatusText(`串口刷新失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const loadConfig = useCallback(async () => {
    try {
      const payload = await api.lowerBoardSim.getConfig();
      setConfig(payload.config);
      setConfigPath(payload.configPath);
    } catch (error) {
      setStatusText(`配置加载失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const applyConfig = useCallback(async () => {
    setStatusText(runningRef.current ? "正在应用配置" : "正在保存配置");
    try {
      if (runningRef.current) {
        const status = await api.lowerBoardSim.updateConfig(configRef.current);
        setConfig(status.config);
        setStats(status.stats);
        setStatusText(status.message);
        return;
      }

      const payload = await api.lowerBoardSim.saveConfig(configRef.current);
      setConfig(payload.config);
      setConfigPath(payload.configPath);
      setStatusText("下板模拟配置已保存");
    } catch (error) {
      setStatusText(`配置保存失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const startSimulator = useCallback(async () => {
    setStatusText("正在启动下板模拟");
    try {
      const status = await api.lowerBoardSim.start(configRef.current);
      setRunning(status.running);
      setStats(status.stats);
      setStatusText(status.message);
    } catch (error) {
      setRunning(false);
      setStatusText(`启动失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const stopSimulator = useCallback(async () => {
    setStatusText("正在停止下板模拟");
    try {
      const status = await api.lowerBoardSim.stop();
      setRunning(status.running);
      setStats(status.stats);
      setStatusText(status.message);
    } catch (error) {
      setStatusText(`停止失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const resetStats = useCallback(async () => {
    try {
      const status = await api.lowerBoardSim.resetStats();
      setStats(status.stats);
      setStatusText(status.message);
    } catch (error) {
      setStatusText(`统计复位失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  useEffect(() => {
    void loadConfig();
    void refreshPorts();
  }, [loadConfig, refreshPorts]);

  useEffect(() => {
    const offStatus = api.lowerBoardSim.onStatus((event) => {
      setRunning(event.running);
      setStats(event.stats);
      setStatusText(event.message);
    });
    const offFrame = api.lowerBoardSim.onFrame((event) => {
      appendFrameLog(event);
    });

    return () => {
      offStatus();
      offFrame();
    };
  }, [api, appendFrameLog]);

  const stateClass = running ? "ok" : statusText.includes("失败") || statusText.includes("错误") ? "error" : "idle";

  return (
    <main className="workspace lower-sim-workspace">
      <header className="workspace-header">
        <div className="title-block">
          <h1>下板模拟</h1>
          <p>{configPath || "下板模拟配置待加载"}</p>
        </div>
        <div className="header-cluster">
          <div className={`run-indicator ${stateClass}`} aria-label="下板模拟状态">
            <span />
            <strong>{running ? `运行中 ${config.port}` : statusText}</strong>
          </div>
          <button type="button" className="icon-button" onClick={() => void refreshPorts()} title="刷新串口">
            <RefreshCw size={18} />
          </button>
          <button type="button" className="command-button" onClick={() => void applyConfig()}>
            <Save size={18} />
            {running ? "应用配置" : "保存配置"}
          </button>
        </div>
      </header>

      <div className="sim-layout">
        <section className="panel sim-control-panel">
          <div className="serial-section-heading">
            <Cable size={18} />
            <h2>端口</h2>
          </div>

          <label className="field">
            <span>USB-TTL 端口</span>
            <input
              list="lower-board-port-options"
              value={config.port}
              disabled={running}
              onChange={(event) => setField("port", event.target.value.toUpperCase())}
            />
            <datalist id="lower-board-port-options">
              {portOptions.map((port) => (
                <option key={port} value={port} />
              ))}
            </datalist>
          </label>

          <div className="sim-protocol-row">
            <span>UART1</span>
            <strong>4800 8N1</strong>
          </div>

          <div className="serial-open-row">
            <button type="button" className="action-button" onClick={() => void refreshPorts()}>
              <RefreshCw size={17} />
              刷新
            </button>
            <button
              type="button"
              className={`action-button ${running ? "stop" : "primary"}`}
              onClick={() => (running ? void stopSimulator() : void startSimulator())}
            >
              {running ? <Square size={17} /> : <Play size={17} />}
              {running ? "停止" : "启动"}
            </button>
          </div>

          <div className="serial-section-heading">
            <Gauge size={18} />
            <h2>模拟参数</h2>
          </div>

          <div className="form-grid sim-form">
            <label className="field">
              <span>设备类型</span>
              <input
                type="number"
                min={1}
                max={9}
                value={config.deviceType}
                onChange={(event) => setField("deviceType", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>母线电压 V</span>
              <input
                type="number"
                min={0}
                max={65535}
                value={config.busVoltageV}
                onChange={(event) => setField("busVoltageV", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>板温 C</span>
              <input
                type="number"
                min={-40}
                max={215}
                value={config.boardTemperatureC}
                onChange={(event) => setField("boardTemperatureC", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>故障码</span>
              <input
                type="number"
                min={0}
                max={65535}
                value={config.faultCode}
                onChange={(event) => setField("faultCode", Number(event.target.value))}
              />
            </label>
          </div>

          <label className="field">
            <span>速度爬坡 RPM/s</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={config.speedRampRpmPerSecond}
              onChange={(event) => setField("speedRampRpmPerSecond", Number(event.target.value))}
            />
          </label>

          <div className="serial-section-heading">
            <AlertTriangle size={18} />
            <h2>故障注入</h2>
          </div>

          <label className="switch-row">
            <input type="checkbox" checked={config.offlineMode} onChange={(event) => setField("offlineMode", event.target.checked)} />
            <span>离线模式</span>
          </label>

          <div className="form-grid sim-form">
            <label className="field">
              <span>响应延迟 ms</span>
              <input
                type="number"
                min={0}
                max={5000}
                value={config.responseDelayMs}
                onChange={(event) => setField("responseDelayMs", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>丢包率 %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={config.dropRatePercent}
                onChange={(event) => setField("dropRatePercent", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>坏校验 %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={config.badChecksumRatePercent}
                onChange={(event) => setField("badChecksumRatePercent", Number(event.target.value))}
              />
            </label>
            <div className="sim-fault-code">
              <span>{formatHexWord(config.faultCode)}</span>
            </div>
          </div>

          <button type="button" className="action-button primary sim-apply-button" onClick={() => void applyConfig()}>
            <Zap size={17} />
            {running ? "应用到运行中" : "保存参数"}
          </button>
        </section>

        <section className="panel sim-dashboard-panel">
          <div className="terminal-toolbar">
            <div>
              <h2>通信状态</h2>
              <p>{statusText}</p>
            </div>
            <div className="terminal-actions">
              <button type="button" className="icon-button" onClick={() => void resetStats()} title="复位统计">
                <RotateCcw size={18} />
              </button>
              <button type="button" className="icon-button" onClick={() => setFrameLog("")} title="清空帧日志">
                <Trash2 size={18} />
              </button>
            </div>
          </div>

          <div className="sim-dashboard-body">
            <div className="sim-status-grid">
              <StatCell label="RX 字节" value={stats.rxBytes} />
              <StatCell label="TX 字节" value={stats.txBytes} />
              <StatCell label="有效命令" value={stats.commandFrames} />
              <StatCell label="状态回包" value={stats.statusFrames} />
              <StatCell label="CRC 错误" value={stats.crcErrors} />
              <StatCell label="同步错误" value={stats.syncErrors} />
              <StatCell label="丢包" value={stats.droppedResponses} />
              <StatCell label="坏校验" value={stats.badChecksumResponses} />
              <StatCell label="清故障脉冲" value={stats.faultClearPulses} />
            </div>

            <div className="sim-live-grid">
              <div className="sim-live-block">
                <div>
                  <Activity size={17} />
                  <strong>最后命令</strong>
                </div>
                <dl>
                  <dt>run</dt>
                  <dd>{lastCommand ? (lastCommand.run ? "true" : "false") : "-"}</dd>
                  <dt>target</dt>
                  <dd>{lastCommand ? `${lastCommand.targetSpeedRpm} RPM` : "-"}</dd>
                  <dt>faultClear</dt>
                  <dd>{lastCommand ? (lastCommand.faultClear ? "true" : "false") : "-"}</dd>
                  <dt>type</dt>
                  <dd>{lastCommand ? `0x${lastCommand.deviceType.toString(16).padStart(2, "0").toUpperCase()}` : "-"}</dd>
                </dl>
              </div>

              <div className="sim-live-block">
                <div>
                  <Gauge size={17} />
                  <strong>最后状态</strong>
                </div>
                <dl>
                  <dt>speed</dt>
                  <dd>{lastStatus ? `${lastStatus.currentSpeedRpm} RPM` : "-"}</dd>
                  <dt>bus</dt>
                  <dd>{lastStatus ? `${lastStatus.busVoltageV} V / ${lastStatus.busCurrentMa} mA` : "-"}</dd>
                  <dt>power</dt>
                  <dd>{lastStatus ? `${lastStatus.motorPowerW} W` : "-"}</dd>
                  <dt>fault</dt>
                  <dd>{lastStatus ? formatHexWord(lastStatus.faultCode) : "-"}</dd>
                </dl>
              </div>
            </div>
          </div>

          <pre className="sim-frame-log">{frameLog || "等待 ESP32 下板 UART1 命令帧...\n"}</pre>
        </section>
      </div>
    </main>
  );
}
