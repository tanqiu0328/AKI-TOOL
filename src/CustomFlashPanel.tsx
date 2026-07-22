import { FileCheck2, FolderOpen, Play, Plus, Square, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  parseCustomFlashAddress,
  validateCustomFlashItems,
  type ValidatedCustomFlashItem
} from "../shared/customFlash.ts";
import type {
  AkiApi,
  CustomFlashFileInspection,
  CustomFlashRequest,
  CustomFlashRequestItem,
  EspConfig
} from "./types";

type CustomFlashDraftItem = {
  id: string;
  name: string;
  filePath: string;
  inspection: CustomFlashFileInspection | null;
  address: string;
  enabled: boolean;
};

type CustomFlashSummaryItem = {
  item: ValidatedCustomFlashItem;
  inspection: CustomFlashFileInspection;
};

type CustomFlashSummary = {
  items: CustomFlashSummaryItem[];
  requestItems: CustomFlashRequestItem[];
};

function createDraftItem(id: number): CustomFlashDraftItem {
  return {
    id: `custom-flash-${id}`,
    name: id === 1 ? "临时自定义烧录项" : `自定义烧录项 ${id}`,
    filePath: "",
    inspection: null,
    address: "0x10000",
    enabled: true
  };
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
  const nextItemId = useRef(2);
  const [items, setItems] = useState<CustomFlashDraftItem[]>([createDraftItem(1)]);
  const [summary, setSummary] = useState<CustomFlashSummary | null>(null);
  const [reviewError, setReviewError] = useState("");

  const enabledItems = useMemo(() => items.filter((item) => item.enabled), [items]);
  const canReview = Boolean(
    config.port &&
      enabledItems.length > 0 &&
      enabledItems.every(
        (item) => item.name.trim() && item.inspection?.exists && parseCustomFlashAddress(item.address).valid
      ) &&
      !isRunning
  );

  function invalidateReview() {
    setSummary(null);
    setReviewError("");
  }

  function updateItem(id: string, patch: Partial<CustomFlashDraftItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    invalidateReview();
  }

  function addItem() {
    const id = nextItemId.current;
    nextItemId.current += 1;
    setItems((current) => [...current, createDraftItem(id)]);
    invalidateReview();
    onStatus("已添加自定义烧录项");
  }

  function deleteItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    invalidateReview();
    onStatus("已删除自定义烧录项");
  }

  async function chooseFile(item: CustomFlashDraftItem) {
    const selected = await api.dialog.selectFile({
      title: `为“${item.name}”选择固定 BIN`,
      filters: [
        { name: "BIN 镜像", extensions: ["bin"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (!selected) {
      onStatus("已取消选择固定 BIN");
      return;
    }

    const inspection = await api.esp.inspectCustomFlashFile(selected);
    updateItem(item.id, { filePath: selected, inspection });
    onStatus(inspection.exists ? "固定 BIN 已选择" : "固定 BIN 不存在");
  }

  async function review() {
    if (!canReview) {
      return;
    }

    try {
      const inspections = await Promise.all(
        enabledItems.map((item) => api.esp.inspectCustomFlashFile(item.filePath))
      );
      const missingItemIndex = inspections.findIndex((inspection) => !inspection.exists);
      if (missingItemIndex >= 0) {
        throw new Error(`自定义烧录项“${enabledItems[missingItemIndex].name}”的固定 BIN 不存在`);
      }

      const requestItems = enabledItems.map((item, index) => ({
        name: item.name.trim(),
        filePath: inspections[index].filePath,
        address: item.address,
        enabled: true,
        expectedFileSize: inspections[index].size
      }));
      const validatedItems = validateCustomFlashItems(requestItems);
      const nextInspections = new Map(enabledItems.map((item, index) => [item.id, inspections[index]]));
      setItems((current) => current.map((item) => ({
        ...item,
        inspection: nextInspections.get(item.id) ?? item.inspection
      })));
      setSummary({
        requestItems,
        items: validatedItems.map((item, index) => ({ item, inspection: inspections[index] }))
      });
      setReviewError("");
      onStatus("请确认自定义烧录摘要");
    } catch (error) {
      const message = getErrorMessage(error);
      setSummary(null);
      setReviewError(message);
      onStatus(message);
    }
  }

  function run() {
    if (!summary) {
      return;
    }

    onRun({ config, items: summary.requestItems });
  }

  return (
    <section className="panel custom-flash-panel">
      <div className="panel-heading">
        <div>
          <h2>临时自定义烧录方案</h2>
          <p>仅启用项进入确认，并由一次底层写入命令批量提交</p>
        </div>
        <FileCheck2 size={20} />
      </div>

      <div className="custom-flash-list">
        {items.map((item, index) => {
          const position = index + 1;
          const parsedAddress = parseCustomFlashAddress(item.address);
          return (
            <section className="custom-flash-item" key={item.id}>
              <div className="custom-flash-item-heading">
                <label className="switch-row custom-flash-enabled">
                  <input
                    type="checkbox"
                    aria-label={`烧录项 ${position} 临时启用`}
                    checked={item.enabled}
                    disabled={isRunning}
                    onChange={(event) => updateItem(item.id, { enabled: event.target.checked })}
                  />
                  <span>烧录项 {position}</span>
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除烧录项 ${position}`}
                  title="删除烧录项"
                  disabled={isRunning}
                  onClick={() => deleteItem(item.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div className="custom-flash-form">
                <label className="field">
                  <span>名称</span>
                  <input
                    aria-label={`烧录项 ${position} 名称`}
                    value={item.name}
                    disabled={isRunning}
                    onChange={(event) => updateItem(item.id, { name: event.target.value })}
                  />
                </label>

                <label className="field">
                  <span>固定 BIN</span>
                  <div className="path-control custom-flash-file">
                    <input value={item.inspection?.fileName ?? ""} placeholder="请选择 BIN 文件" readOnly />
                    <button
                      type="button"
                      className="command-button"
                      aria-label={`烧录项 ${position} 选择固定 BIN`}
                      onClick={() => void chooseFile(item)}
                      disabled={isRunning}
                    >
                      <FolderOpen size={16} />
                      选择固定 BIN
                    </button>
                  </div>
                </label>

                <label className="field">
                  <span>十六进制绝对地址</span>
                  <input
                    aria-label={`烧录项 ${position} 十六进制绝对地址`}
                    value={item.address}
                    disabled={isRunning}
                    onChange={(event) => updateItem(item.id, { address: event.target.value })}
                    placeholder="例如 0x10000"
                  />
                  {item.enabled && item.address && !parsedAddress.valid ? (
                    <small className="field-error">请输入按 4 KiB 对齐的十六进制地址</small>
                  ) : null}
                </label>
              </div>
            </section>
          );
        })}
      </div>

      <button type="button" className="command-button custom-flash-add" onClick={addItem} disabled={isRunning}>
        <Plus size={16} />
        添加烧录项
      </button>

      <button type="button" className="action-button primary custom-flash-review" onClick={() => void review()} disabled={!canReview}>
        查看确认摘要
      </button>

      {reviewError ? <p className="custom-flash-error" role="alert">{reviewError}</p> : null}

      {summary ? (
        <section className="custom-flash-summary" aria-label="确认摘要">
          <h3>确认摘要</h3>
          <dl className="custom-flash-summary-meta">
            <div><dt>芯片</dt><dd>{config.chip}</dd></div>
            <div><dt>串口</dt><dd>{config.port}</dd></div>
          </dl>
          <div className="custom-flash-summary-list">
            {summary.items.map(({ item, inspection }) => (
              <article className="custom-flash-summary-item" key={`${item.name}-${item.filePath}-${item.address}`}>
                <h4>{item.name}</h4>
                <dl>
                  <div><dt>文件名</dt><dd>{inspection.fileName}</dd></div>
                  <div><dt>文件大小</dt><dd>{formatFileSize(inspection.size)}</dd></div>
                  <div><dt>起始地址</dt><dd>{formatAddress(item.startAddress)}</dd></div>
                  <div><dt>结束地址</dt><dd>{formatAddress(item.startAddress + Math.max(0, inspection.size - 1))}</dd></div>
                </dl>
              </article>
            ))}
          </div>
          <p className="custom-flash-warning">
            多项写入不具备事务式回滚，中途失败时设备可能处于部分写入状态
          </p>
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
