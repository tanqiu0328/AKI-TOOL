import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  Clock3,
  Copy,
  FileDown,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  Terminal,
  Trash2,
  Unplug,
  Zap
} from "lucide-react";
import type {
  AkiApi,
  SerialConfig,
  SerialDataBits,
  SerialDataEvent,
  SerialDisplayMode,
  SerialLineSignals,
  SerialParity,
  SerialPortInfo,
  SerialStatusEvent,
  SerialStopBits,
  SerialTextEncoding
} from "./types";

const initialSerialConfig: SerialConfig = {
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

const emptySignals: SerialLineSignals = {
  dtr: false,
  rts: false,
  cts: null,
  dsr: null,
  dcd: null
};

const baudOptions = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000];
const dataBitOptions: SerialDataBits[] = [5, 6, 7, 8];
const parityOptions: Array<{ value: SerialParity; label: string }> = [
  { value: "none", label: "None" },
  { value: "even", label: "Even" },
  { value: "odd", label: "Odd" },
  { value: "mark", label: "Mark" },
  { value: "space", label: "Space" }
];
const stopBitOptions: SerialStopBits[] = [1, 1.5, 2];
const encodingOptions: SerialTextEncoding[] = ["utf-8", "gbk"];
const receiveBufferLimit = 200000;

type SerialAssistantProps = {
  api: AkiApi;
  isDesktop: boolean;
};

type SetSerialField = <K extends keyof SerialConfig>(key: K, value: SerialConfig[K]) => void;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function formatHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function decodeText(bytes: Uint8Array, encoding: SerialTextEncoding) {
  try {
    return new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function formatTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function normalizeHexInput(input: string) {
  return input.replace(/0x/gi, "").replace(/[\s,;:_-]/g, "");
}

function validateHexInput(input: string) {
  const cleaned = normalizeHexInput(input);
  if (!cleaned) {
    return "HEX 发送内容为空。";
  }
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    return "HEX 发送内容包含非十六进制字符。";
  }
  if (cleaned.length % 2 !== 0) {
    return "HEX 发送内容必须是偶数字符。";
  }
  return "";
}

function appendWithLimit(current: string, addition: string) {
  return `${current}${addition}`.slice(-receiveBufferLimit);
}

function uniquePortOptions(configPort: string, ports: SerialPortInfo[]) {
  const values = ["AUTO", configPort, ...ports.map((port) => port.path)].filter(Boolean);
  return Array.from(new Set(values));
}

function signalText(value: boolean | null) {
  if (value === null) {
    return "?";
  }
  return value ? "ON" : "OFF";
}

function downloadTextFile(text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `serial-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ModeToggle({
  label,
  mode,
  setMode,
  disabled = false
}: {
  label: string;
  mode: SerialDisplayMode;
  setMode: (mode: SerialDisplayMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented-field" aria-label={label}>
      <span>{label}</span>
      <div className="segmented-control">
        <button type="button" className={mode === "text" ? "active" : ""} onClick={() => setMode("text")} disabled={disabled}>
          Text
        </button>
        <button type="button" className={mode === "hex" ? "active" : ""} onClick={() => setMode("hex")} disabled={disabled}>
          HEX
        </button>
      </div>
    </div>
  );
}

export function SerialAssistant({ api, isDesktop }: SerialAssistantProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(initialSerialConfig);
  const receiveTextRef = useRef("");
  const lastFrameAtRef = useRef<number | null>(null);
  const autoOpenAttemptedRef = useRef(false);

  const [config, setConfig] = useState<SerialConfig>(initialSerialConfig);
  const [configPath, setConfigPath] = useState("");
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const [statusText, setStatusText] = useState("就绪");
  const [receiveText, setReceiveText] = useState("");
  const [sendText, setSendText] = useState("help");
  const [terminalDraft, setTerminalDraft] = useState("");
  const [rxBytes, setRxBytes] = useState(0);
  const [txBytes, setTxBytes] = useState(0);
  const [signals, setSignals] = useState<SerialLineSignals>(emptySignals);

  const portOptions = useMemo(() => uniquePortOptions(config.port, ports), [config.port, ports]);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    receiveTextRef.current = receiveText;
  }, [receiveText]);

  const setField = useCallback<SetSerialField>((key, value) => {
    setConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const setTerminalMode = useCallback((enabled: boolean) => {
    setConfig((current) => ({
      ...current,
      terminalMode: enabled,
      sendMode: enabled ? "text" : current.sendMode
    }));
  }, []);

  const appendSerialEvent = useCallback((event: SerialDataEvent) => {
    const currentConfig = configRef.current;

    if (event.direction === "tx" && !currentConfig.showSent) {
      return;
    }

    const bytes = base64ToBytes(event.base64);
    const mode = event.direction === "tx" ? currentConfig.sendMode : currentConfig.receiveMode;
    const body = mode === "hex" ? `${formatHex(bytes)}\n` : decodeText(bytes, currentConfig.textEncoding);
    const elapsed = lastFrameAtRef.current === null ? Infinity : event.timestamp - lastFrameAtRef.current;
    const shouldHeader = currentConfig.showTimestamp && elapsed >= currentConfig.frameGapMs;
    lastFrameAtRef.current = event.timestamp;
    const prefix = shouldHeader ? `[${formatTimestamp(event.timestamp)}] ${event.direction.toUpperCase()} ` : "";
    const currentText = receiveTextRef.current;
    const needsNewLine = shouldHeader && currentText.length > 0 && !currentText.endsWith("\n");
    const addition = `${needsNewLine ? "\n" : ""}${prefix}${body}`;
    setReceiveText((current) => appendWithLimit(current, addition));
  }, []);

  const refreshPorts = useCallback(async () => {
    setStatusText("正在刷新串口");
    try {
      const nextPorts = await api.serial.listPorts();
      setPorts(nextPorts);
      setStatusText(nextPorts.length > 0 ? `发现 ${nextPorts.length} 个串口` : "未发现串口");
    } catch (error) {
      setPorts([]);
      setStatusText(`串口刷新失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const loadConfig = useCallback(async () => {
    try {
      const payload = await api.serial.getConfig();
      setConfig(payload.config);
      setConfigPath(payload.configPath);
      setSignals({
        ...emptySignals,
        dtr: payload.config.dtr,
        rts: payload.config.rts
      });
    } catch (error) {
      setStatusText(`配置加载失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const saveConfig = useCallback(async () => {
    setStatusText("正在保存配置");
    try {
      const payload = await api.serial.saveConfig(configRef.current);
      setConfig(payload.config);
      setConfigPath(payload.configPath);
      setStatusText("串口配置已保存");
    } catch (error) {
      setStatusText(`配置保存失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const openSerial = useCallback(async () => {
    setStatusText("正在打开串口");
    try {
      const status = await api.serial.open(configRef.current);
      setConnected(status.connected);
      setSignals(status.signals);
      setStatusText(status.message);
    } catch (error) {
      setConnected(false);
      setStatusText(`打开失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const closeSerial = useCallback(async () => {
    setStatusText("正在关闭串口");
    try {
      const status = await api.serial.close();
      setConnected(status.connected);
      setSignals(status.signals);
      setStatusText(status.message);
    } catch (error) {
      setStatusText(`关闭失败: ${getErrorMessage(error)}`);
    }
  }, [api]);

  const sendSerialPayload = useCallback(
    async ({
      value,
      appendLineEnding = false,
      mode
    }: {
      value: string;
      appendLineEnding?: boolean;
      mode?: SerialDisplayMode;
    }) => {
      const currentConfig = configRef.current;
      const sendMode = mode ?? currentConfig.sendMode;

      if (sendMode === "hex") {
        const error = validateHexInput(value);
        if (error) {
          setStatusText(error);
          return false;
        }
      } else if (!value && !appendLineEnding) {
        setStatusText("发送内容为空");
        return false;
      }

      try {
        if (!connected && currentConfig.autoOpen) {
          await openSerial();
        }

        await api.serial.write({
          data: value,
          mode: sendMode,
          encoding: currentConfig.textEncoding,
          appendLineEnding
        });
        setStatusText("发送完成");
        return true;
      } catch (error) {
        setStatusText(`发送失败: ${getErrorMessage(error)}`);
        return false;
      }
    },
    [api, connected, openSerial]
  );

  const sendData = useCallback(
    (appendLineEnding = false) => sendSerialPayload({ value: sendText, appendLineEnding }),
    [sendSerialPayload, sendText]
  );

  const setControlLine = useCallback(
    async (key: "dtr" | "rts", value: boolean) => {
      const nextConfig = { ...configRef.current, [key]: value };
      setConfig(nextConfig);
      try {
        const nextSignals = await api.serial.setControlLines({
          dtr: nextConfig.dtr,
          rts: nextConfig.rts
        });
        setSignals(nextSignals);
      } catch (error) {
        setStatusText(`控制线设置失败: ${getErrorMessage(error)}`);
      }
    },
    [api]
  );

  useEffect(() => {
    void loadConfig();
    void refreshPorts();
  }, [loadConfig, refreshPorts]);

  useEffect(() => {
    const offData = api.serial.onData((event) => {
      if (event.direction === "rx") {
        setRxBytes((current) => current + event.byteLength);
      } else {
        setTxBytes((current) => current + event.byteLength);
      }
      appendSerialEvent(event);
    });

    const offStatus = api.serial.onStatus((event: SerialStatusEvent) => {
      setConnected(event.connected);
      setSignals(event.signals);
      setStatusText(event.message);
    });

    return () => {
      offData();
      offStatus();
    };
  }, [api, appendSerialEvent]);

  useEffect(() => {
    if (config.autoOpen && !autoOpenAttemptedRef.current) {
      autoOpenAttemptedRef.current = true;
      void openSerial();
    }
  }, [config.autoOpen, openSerial]);

  useEffect(() => {
    if (!config.timedSend) {
      return;
    }

    const interval = window.setInterval(() => {
      void sendData(false);
    }, config.timedSendIntervalMs);

    return () => window.clearInterval(interval);
  }, [config.timedSend, config.timedSendIntervalMs, sendData]);

  useEffect(() => {
    if (config.terminalMode && config.sendMode !== "text") {
      setField("sendMode", "text");
    }
  }, [config.sendMode, config.terminalMode, setField]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [config.terminalMode, receiveText, terminalDraft]);

  function clearReceive() {
    setReceiveText("");
    lastFrameAtRef.current = null;
    setStatusText("接收区已清空");
  }

  function resetCounters() {
    setRxBytes(0);
    setTxBytes(0);
    setStatusText("计数已复位");
  }

  async function copyReceive() {
    if (!receiveText.trim()) {
      setStatusText("没有可复制数据");
      return;
    }

    try {
      await navigator.clipboard.writeText(receiveText);
      setStatusText("接收数据已复制");
    } catch (error) {
      setStatusText(`复制失败: ${getErrorMessage(error)}`);
    }
  }

  function saveReceive() {
    if (!receiveText.trim()) {
      setStatusText("没有可保存数据");
      return;
    }

    downloadTextFile(receiveText);
    setStatusText(isDesktop ? "已保存到下载任务" : "已导出接收数据");
  }

  async function sendTerminalLine() {
    const sent = await sendSerialPayload({
      value: terminalDraft,
      mode: "text",
      appendLineEnding: true
    });

    if (sent) {
      setTerminalDraft("");
    }
  }

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!config.terminalMode) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void sendTerminalLine();
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      setTerminalDraft((current) => current.slice(0, -1));
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setTerminalDraft((current) => `${current}${event.key}`);
    }
  }

  function handleTerminalPaste(event: ClipboardEvent<HTMLDivElement>) {
    if (!config.terminalMode) {
      return;
    }

    const text = event.clipboardData.getData("text");
    if (!text) {
      return;
    }

    event.preventDefault();
    setTerminalDraft((current) => `${current}${text.replace(/[\r\n]+/g, "")}`);
  }

  const stateClass = connected ? "ok" : statusText.includes("失败") || statusText.includes("错误") ? "error" : "idle";

  return (
    <main className="workspace serial-workspace">
      <header className="workspace-header">
        <div className="title-block">
          <h1>串口助手</h1>
          <p>{configPath || "串口配置待加载"}</p>
        </div>
        <div className="header-cluster">
          <div className={`run-indicator ${stateClass}`} aria-label="串口状态">
            <span />
            <strong>{connected ? `已连接 ${config.port}` : statusText}</strong>
          </div>
          <button type="button" className="icon-button" onClick={() => void refreshPorts()} title="刷新串口">
            <RefreshCw size={18} />
          </button>
          <button type="button" className="command-button" onClick={() => void saveConfig()}>
            <Zap size={18} />
            保存配置
          </button>
        </div>
      </header>

      <div className="serial-layout">
        <section className="panel serial-control-panel">
          <div className="serial-section-heading">
            <Terminal size={18} />
            <h2>端口</h2>
          </div>

          <div className="form-grid serial-form">
            <label className="field">
              <span>端口名</span>
              <input
                list="serial-port-options"
                value={config.port}
                onChange={(event) => setField("port", event.target.value.toUpperCase())}
              />
              <datalist id="serial-port-options">
                {portOptions.map((port) => (
                  <option key={port} value={port} />
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>波特率</span>
              <select value={config.baudRate} onChange={(event) => setField("baudRate", Number(event.target.value))}>
                {baudOptions.map((baud) => (
                  <option key={baud} value={baud}>
                    {baud}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>数据位</span>
              <select value={config.dataBits} onChange={(event) => setField("dataBits", Number(event.target.value) as SerialDataBits)}>
                {dataBitOptions.map((bits) => (
                  <option key={bits} value={bits}>
                    {bits}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>校验位</span>
              <select value={config.parity} onChange={(event) => setField("parity", event.target.value as SerialParity)}>
                {parityOptions.map((parity) => (
                  <option key={parity.value} value={parity.value}>
                    {parity.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>停止位</span>
              <select value={config.stopBits} onChange={(event) => setField("stopBits", Number(event.target.value) as SerialStopBits)}>
                {stopBitOptions.map((bits) => (
                  <option key={bits} value={bits}>
                    {bits}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>编码</span>
              <select value={config.textEncoding} onChange={(event) => setField("textEncoding", event.target.value as SerialTextEncoding)}>
                {encodingOptions.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="serial-open-row">
            <button type="button" className="action-button" onClick={() => void refreshPorts()}>
              <RefreshCw size={17} />
              刷新
            </button>
            <button
              type="button"
              className={`action-button ${connected ? "stop" : "primary"}`}
              onClick={() => (connected ? void closeSerial() : void openSerial())}
            >
              {connected ? <Unplug size={17} /> : <Power size={17} />}
              {connected ? "关闭" : "打开"}
            </button>
          </div>

          <div className="line-control-grid">
            <label className="switch-row">
              <input type="checkbox" checked={signals.dtr} onChange={(event) => void setControlLine("dtr", event.target.checked)} />
              <span>DTR</span>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={signals.rts} onChange={(event) => void setControlLine("rts", event.target.checked)} />
              <span>RTS</span>
            </label>
          </div>

          <div className="signal-row" aria-label="状态线">
            <span className={signals.cts ? "active" : ""}>CTS {signalText(signals.cts)}</span>
            <span className={signals.dsr ? "active" : ""}>DSR {signalText(signals.dsr)}</span>
            <span className={signals.dcd ? "active" : ""}>DCD {signalText(signals.dcd)}</span>
          </div>

          <div className="serial-section-heading">
            <Clock3 size={18} />
            <h2>接收</h2>
          </div>

          <ModeToggle label="显示" mode={config.receiveMode} setMode={(mode) => setField("receiveMode", mode)} />

          <label className="switch-row">
            <input type="checkbox" checked={config.showTimestamp} onChange={(event) => setField("showTimestamp", event.target.checked)} />
            <span>时间戳断帧</span>
          </label>

          <label className="field inline-field">
            <span>断帧间隔</span>
            <div>
              <input
                type="number"
                min={0}
                value={config.frameGapMs}
                onChange={(event) => setField("frameGapMs", Number(event.target.value))}
              />
              <small>ms</small>
            </div>
          </label>

          <div className="serial-section-heading">
            <Send size={18} />
            <h2>发送</h2>
          </div>

          <ModeToggle
            label="格式"
            mode={config.sendMode}
            setMode={(mode) => setField("sendMode", config.terminalMode ? "text" : mode)}
            disabled={config.terminalMode}
          />

          <div className="serial-switch-grid">
            <label className="switch-row">
              <input type="checkbox" checked={config.terminalMode} onChange={(event) => setTerminalMode(event.target.checked)} />
              <span>终端模式</span>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={config.showSent} onChange={(event) => setField("showSent", event.target.checked)} />
              <span>显示发送内容</span>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={config.autoOpen} onChange={(event) => setField("autoOpen", event.target.checked)} />
              <span>自动打开串口</span>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={config.autoReconnect} onChange={(event) => setField("autoReconnect", event.target.checked)} />
              <span>自动重连</span>
            </label>
          </div>

          <label className="field inline-field">
            <span>定时发送</span>
            <div>
              <input
                type="checkbox"
                checked={config.timedSend}
                onChange={(event) => setField("timedSend", event.target.checked)}
              />
              <input
                type="number"
                min={100}
                step={100}
                value={config.timedSendIntervalMs}
                onChange={(event) => setField("timedSendIntervalMs", Number(event.target.value))}
              />
              <small>ms</small>
            </div>
          </label>
        </section>

        <section className={`panel serial-terminal-panel ${config.terminalMode ? "terminal-mode" : ""}`}>
          <div className="terminal-toolbar">
            <div>
              <h2>{config.terminalMode ? "终端窗口" : "接收与发送"}</h2>
              <p>{statusText}</p>
            </div>
            <div className="terminal-actions">
              <button type="button" className="icon-button" onClick={copyReceive} title="复制接收数据">
                <Copy size={18} />
              </button>
              <button type="button" className="icon-button" onClick={saveReceive} title="保存接收数据">
                <FileDown size={18} />
              </button>
              <button type="button" className="icon-button" onClick={clearReceive} title="清空接收数据">
                <Trash2 size={18} />
              </button>
            </div>
          </div>

          <div
            ref={terminalRef}
            className="serial-receive-output"
            tabIndex={config.terminalMode ? 0 : -1}
            role={config.terminalMode ? "textbox" : undefined}
            aria-label={config.terminalMode ? "终端输入窗口" : "接收数据"}
            aria-multiline={config.terminalMode ? true : undefined}
            onClick={() => terminalRef.current?.focus()}
            onKeyDown={handleTerminalKeyDown}
            onPaste={handleTerminalPaste}
          >
            <pre className="serial-receive-text">{receiveText}</pre>
            {config.terminalMode ? (
              <div className="serial-terminal-draft-line">
                <span>{terminalDraft}</span>
                <span className="serial-terminal-caret" aria-hidden="true" />
              </div>
            ) : null}
          </div>

          {config.terminalMode ? null : (
            <div className="serial-send-panel">
              <textarea
                value={sendText}
                onChange={(event) => setSendText(event.target.value)}
                spellCheck={false}
                aria-label="发送内容"
              />
              <button type="button" className="serial-send-button" onClick={() => void sendData(false)} disabled={!connected && !config.autoOpen}>
                <Send size={34} />
              </button>
            </div>
          )}

          <footer className="serial-counter-bar">
            <span>发送: {txBytes}</span>
            <span>接收: {rxBytes}</span>
            <button type="button" onClick={resetCounters}>
              <RotateCcw size={15} />
              复位计数
            </button>
            <span className="serial-mode-indicator">
              {config.timedSend ? <Play size={15} /> : <Pause size={15} />}
              {config.timedSend ? `${config.timedSendIntervalMs} ms` : "定时关闭"}
            </span>
          </footer>
        </section>
      </div>
    </main>
  );
}
