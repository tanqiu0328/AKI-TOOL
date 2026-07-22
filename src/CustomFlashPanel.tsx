import { FileCheck2, FolderOpen, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AkiApi,
  CustomFlashFileInspection,
  CustomFlashRequest,
  EspConfig
} from "./types";

type CustomFlashSummary = {
  inspection: CustomFlashFileInspection;
  startAddress: number;
  endAddress: number;
};

function parseAlignedAddress(address: string) {
  if (!/^0x[0-9a-f]+$/i.test(address)) {
    return null;
  }

  const value = Number.parseInt(address.slice(2), 16);
  return Number.isSafeInteger(value) && value % 4096 === 0 ? value : null;
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
  }

  return `${(size / 1024).toFixed(2)} KiB`;
}

function formatAddress(address: number) {
  return `0x${address.toString(16)}`;
}

export function CustomFlashPanel({
  api,
  config,
  isRunning,
  onRun,
  onStatus,
  onStop
}: {
  api: AkiApi;
  config: EspConfig;
  isRunning: boolean;
  onRun: (request: CustomFlashRequest) => void;
  onStatus: (message: string) => void;
  onStop: () => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const [name, setName] = useState("临时自定义烧录项");
  const [filePath, setFilePath] = useState("");
  const [inspection, setInspection] = useState<CustomFlashFileInspection | null>(null);
  const [address, setAddress] = useState("0x10000");
  const [summary, setSummary] = useState<CustomFlashSummary | null>(null);

  const parsedAddress = useMemo(() => parseAlignedAddress(address), [address]);
  const canReview = Boolean(
    enabled && name.trim() && config.port && inspection?.exists && parsedAddress !== null && !isRunning
  );

  async function chooseFile() {
    const selected = await api.dialog.selectFile({
      title: "选择固定 BIN",
      filters: [
        { name: "BIN 镜像", extensions: ["bin"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (!selected) {
      onStatus("已取消选择固定 BIN");
      return;
    }

    const nextInspection = await api.esp.inspectCustomFlashFile(selected);
    setFilePath(selected);
    setInspection(nextInspection);
    setSummary(null);
    onStatus(nextInspection.exists ? "固定 BIN 已选择" : "固定 BIN 不存在");
  }

  async function review() {
    if (!canReview || parsedAddress === null) {
      return;
    }

    const nextInspection = await api.esp.inspectCustomFlashFile(filePath);
    if (!nextInspection.exists) {
      setInspection(nextInspection);
      setSummary(null);
      onStatus("固定 BIN 不存在");
      return;
    }

    setInspection(nextInspection);
    setSummary({
      inspection: nextInspection,
      startAddress: parsedAddress,
      endAddress: parsedAddress + Math.max(0, nextInspection.size - 1)
    });
    onStatus("请确认自定义烧录摘要");
  }

  function updateAddress(value: string) {
    setAddress(value);
    setSummary(null);
  }

  function run() {
    if (!summary) {
      return;
    }

    onRun({
      config,
      item: { name: name.trim(), filePath: summary.inspection.filePath, address },
      expectedFileSize: summary.inspection.size
    });
  }

  return (
    <section className="panel custom-flash-panel">
      <div className="panel-heading">
        <div>
          <h2>临时自定义烧录项</h2>
          <p>独立写入固定 BIN，不使用 ESP-IDF 构建产物</p>
        </div>
        <FileCheck2 size={20} />
      </div>

      <label className="switch-row custom-flash-enabled">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isRunning}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setSummary(null);
          }}
        />
        <span>启用此自定义烧录项</span>
      </label>

      <div className="custom-flash-form">
        <label className="field">
          <span>名称</span>
          <input
            value={name}
            disabled={isRunning}
            onChange={(event) => {
              setName(event.target.value);
              setSummary(null);
            }}
          />
        </label>

        <label className="field">
          <span>固定 BIN</span>
          <div className="path-control custom-flash-file">
            <input value={inspection?.fileName ?? ""} placeholder="请选择 BIN 文件" readOnly />
            <button type="button" className="command-button" onClick={() => void chooseFile()} disabled={isRunning}>
              <FolderOpen size={16} />
              选择固定 BIN
            </button>
          </div>
        </label>

        <label className="field">
          <span>十六进制绝对地址</span>
          <input
            aria-label="十六进制绝对地址"
            value={address}
            disabled={isRunning}
            onChange={(event) => updateAddress(event.target.value)}
            placeholder="例如 0x10000"
          />
          {address && parsedAddress === null ? <small className="field-error">请输入按 4 KiB 对齐的十六进制地址</small> : null}
        </label>
      </div>

      <button type="button" className="action-button primary custom-flash-review" onClick={() => void review()} disabled={!canReview}>
        查看确认摘要
      </button>

      {summary ? (
        <section className="custom-flash-summary" aria-label="确认摘要">
          <h3>确认摘要</h3>
          <dl>
            <div><dt>芯片</dt><dd>{config.chip}</dd></div>
            <div><dt>串口</dt><dd>{config.port}</dd></div>
            <div><dt>文件名</dt><dd>{summary.inspection.fileName}</dd></div>
            <div><dt>文件大小</dt><dd>{formatFileSize(summary.inspection.size)}</dd></div>
            <div><dt>起始地址</dt><dd>{formatAddress(summary.startAddress)}</dd></div>
            <div><dt>结束地址</dt><dd>{formatAddress(summary.endAddress)}</dd></div>
          </dl>
          <div className="danger-row">
            <button type="button" className="action-button primary" onClick={run} disabled={isRunning}>
              <Play size={18} />
              确认并烧录
            </button>
            <button type="button" className="action-button stop" onClick={onStop} disabled={!isRunning}>
              <Square size={18} />
              停止
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
