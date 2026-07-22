import {
  CopyPlus,
  FileCheck2,
  FilePlus2,
  FolderOpen,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseCustomFlashAddress,
  removeCustomFlashPlan,
  upsertCustomFlashPlan,
  validateCustomFlashItems,
  type ValidatedCustomFlashItem
} from "../shared/customFlash.ts";
import type {
  AkiApi,
  CustomFlashFileInspection,
  CustomFlashPlan,
  CustomFlashPlanItem,
  CustomFlashRequest,
  CustomFlashRequestItem,
  EspConfig
} from "./types";

type CustomFlashDraftItem = CustomFlashPlanItem & {
  runtimeEnabled: boolean;
  runtimeFilePath: string;
  inspection: CustomFlashFileInspection | null;
};

type CustomFlashDraftPlan = Omit<CustomFlashPlan, "items"> & {
  items: CustomFlashDraftItem[];
};

type CustomFlashSummaryItem = {
  item: ValidatedCustomFlashItem;
  inspection: CustomFlashFileInspection;
};

type CustomFlashSummary = {
  items: CustomFlashSummaryItem[];
  requestItems: CustomFlashRequestItem[];
};

function createPlanItem(id: number): CustomFlashDraftItem {
  return {
    id: `custom-flash-item-${Date.now()}-${id}`,
    name: id === 1 ? "临时自定义烧录项" : `自定义烧录项 ${id}`,
    address: "0x10000",
    defaultEnabled: true,
    fileSource: { kind: "fixed", filePath: "" },
    runtimeEnabled: true,
    runtimeFilePath: "",
    inspection: null
  };
}

function createDraftPlan(id: number): CustomFlashDraftPlan {
  return {
    id: `custom-flash-plan-${Date.now()}-${id}`,
    name: "未命名方案",
    items: [createPlanItem(id)]
  };
}

function toSavedPlan(plan: CustomFlashDraftPlan): CustomFlashPlan {
  return {
    id: plan.id,
    name: plan.name,
    items: plan.items.map(({ id, name, address, defaultEnabled, fileSource }) => ({
      id,
      name,
      address,
      defaultEnabled,
      fileSource
    }))
  };
}

function toDraftPlan(plan: CustomFlashPlan): CustomFlashDraftPlan {
  return {
    ...structuredClone(plan),
    items: plan.items.map((item) => ({
      ...structuredClone(item),
      runtimeEnabled: item.defaultEnabled,
      runtimeFilePath: item.fileSource.kind === "fixed" ? item.fileSource.filePath : "",
      inspection: null
    }))
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
  const nextPlanId = useRef(2);
  const nextItemId = useRef(2);
  const wasRunning = useRef(isRunning);
  const [plans, setPlans] = useState<CustomFlashPlan[]>([]);
  const [activePlanId, setActivePlanId] = useState("");
  const [savedPlan, setSavedPlan] = useState<CustomFlashPlan | null>(null);
  const [draftPlan, setDraftPlan] = useState<CustomFlashDraftPlan>(() => createDraftPlan(1));
  const [summary, setSummary] = useState<CustomFlashSummary | null>(null);
  const [reviewError, setReviewError] = useState("");

  const isDirty = useMemo(
    () => savedPlan === null || JSON.stringify(toSavedPlan(draftPlan)) !== JSON.stringify(savedPlan),
    [draftPlan, savedPlan]
  );
  const enabledItems = useMemo(
    () => draftPlan.items.filter((item) => item.runtimeEnabled),
    [draftPlan.items]
  );
  const canReview = Boolean(
    config.port &&
      enabledItems.length > 0 &&
      enabledItems.every(
        (item) => item.name.trim() && item.inspection?.exists && parseCustomFlashAddress(item.address).valid
      ) &&
      !isRunning
  );

  useEffect(() => {
    let cancelled = false;
    void api.esp.listCustomFlashPlans().then((storedPlans) => {
      if (cancelled) {
        return;
      }
      setPlans(storedPlans);
      if (storedPlans.length > 0) {
        loadPlan(storedPlans[0]);
      }
    }).catch((error) => onStatus(`方案加载失败: ${getErrorMessage(error)}`));
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      const resetDraft = {
        ...draftPlan,
        items: draftPlan.items.map((item) => ({
          ...item,
          runtimeEnabled: item.defaultEnabled,
          runtimeFilePath: item.fileSource.kind === "fixed" ? item.fileSource.filePath : "",
          inspection: item.fileSource.kind === "fixed" && item.runtimeFilePath === item.fileSource.filePath
            ? item.inspection
            : null
        }))
      };
      setDraftPlan(resetDraft);
      setSummary(null);
      setReviewError("");
      inspectFixedFiles(resetDraft);
    }
    wasRunning.current = isRunning;
  }, [isRunning]);

  function invalidateReview() {
    setSummary(null);
    setReviewError("");
  }

  function inspectFixedFiles(plan: CustomFlashDraftPlan) {
    for (const item of plan.items) {
      if (item.fileSource.kind !== "fixed" || !item.fileSource.filePath) {
        continue;
      }
      const fixedFilePath = item.fileSource.filePath;
      void api.esp.inspectCustomFlashFile(fixedFilePath).then((inspection) => {
        setDraftPlan((current) => ({
          ...current,
          items: current.items.map((candidate) =>
            candidate.id === item.id && candidate.runtimeFilePath === fixedFilePath
              ? { ...candidate, inspection }
              : candidate
          )
        }));
      });
    }
  }

  function loadPlan(plan: CustomFlashPlan) {
    const nextDraft = toDraftPlan(plan);
    setActivePlanId(plan.id);
    setSavedPlan(structuredClone(plan));
    setDraftPlan(nextDraft);
    invalidateReview();
    inspectFixedFiles(nextDraft);
  }

  function updatePlan(patch: Partial<Pick<CustomFlashDraftPlan, "name">>) {
    setDraftPlan((current) => ({ ...current, ...patch }));
    invalidateReview();
  }

  function updateItem(id: string, patch: Partial<CustomFlashDraftItem>) {
    setDraftPlan((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, ...patch } : item))
    }));
    invalidateReview();
  }

  function addItem() {
    const id = nextItemId.current;
    nextItemId.current += 1;
    setDraftPlan((current) => ({ ...current, items: [...current.items, createPlanItem(id)] }));
    invalidateReview();
    onStatus("已添加自定义烧录项");
  }

  function deleteItem(id: string) {
    setDraftPlan((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== id)
    }));
    invalidateReview();
    onStatus("已删除自定义烧录项");
  }

  function newPlan() {
    const id = nextPlanId.current;
    nextPlanId.current += 1;
    nextItemId.current = Math.max(nextItemId.current, id + 1);
    setActivePlanId("");
    setSavedPlan(null);
    setDraftPlan(createDraftPlan(id));
    invalidateReview();
    onStatus("已新建未保存方案");
  }

  function discardChanges() {
    if (savedPlan) {
      loadPlan(savedPlan);
    } else {
      newPlan();
    }
    onStatus("已放弃未保存修改");
  }

  async function persistPlan(saveAs: boolean) {
    try {
      const plan = toSavedPlan(draftPlan);
      if (saveAs) {
        const id = nextPlanId.current;
        nextPlanId.current += 1;
        plan.id = `custom-flash-plan-${Date.now()}-${id}`;
        plan.name = `${plan.name.trim()} 副本`;
      }
      const saved = await api.esp.saveCustomFlashPlan(plan);
      setPlans((current) => upsertCustomFlashPlan(current, saved).plans);
      const runtimeById = new Map(draftPlan.items.map((item) => [item.id, item]));
      const nextDraft = toDraftPlan(saved);
      nextDraft.items = nextDraft.items.map((item) => {
        const runtime = runtimeById.get(item.id);
        return runtime
          ? {
              ...item,
              runtimeEnabled: runtime.runtimeEnabled,
              runtimeFilePath: runtime.runtimeFilePath,
              inspection: runtime.inspection
            }
          : item;
      });
      setActivePlanId(saved.id);
      setSavedPlan(structuredClone(saved));
      setDraftPlan(nextDraft);
      invalidateReview();
      onStatus(saveAs ? "方案已另存为" : "方案已保存");
    } catch (error) {
      const message = getErrorMessage(error);
      setReviewError(message);
      onStatus(message);
    }
  }

  async function deletePlan() {
    if (!savedPlan) {
      return;
    }
    try {
      await api.esp.deleteCustomFlashPlan(savedPlan.id);
      const remainingPlans = removeCustomFlashPlan(plans, savedPlan.id).plans;
      setPlans(remainingPlans);
      if (remainingPlans.length > 0) {
        loadPlan(remainingPlans[0]);
      } else {
        newPlan();
      }
      onStatus("方案已删除");
    } catch (error) {
      onStatus(`方案删除失败: ${getErrorMessage(error)}`);
    }
  }

  async function chooseFile(item: CustomFlashDraftItem, selection: "saved-source" | "runtime") {
    const temporarySelection = item.fileSource.kind === "prompt" || selection === "runtime";
    const selected = await api.dialog.selectFile({
      title: temporarySelection ? `为“${item.name}”选择本次 BIN` : `为“${item.name}”选择固定 BIN`,
      filters: [
        { name: "BIN 镜像", extensions: ["bin"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (!selected) {
      onStatus(temporarySelection ? "已取消本次文件选择" : "已取消选择固定 BIN");
      return;
    }

    const inspection = await api.esp.inspectCustomFlashFile(selected);
    updateItem(item.id, {
      runtimeFilePath: selected,
      inspection,
      ...(temporarySelection ? {} : { fileSource: { kind: "fixed", filePath: selected } })
    });
    onStatus(
      inspection.exists
        ? temporarySelection ? "本次 BIN 已选择" : "固定 BIN 已选择"
        : temporarySelection ? "本次 BIN 不存在" : "固定 BIN 不存在"
    );
  }

  async function review() {
    if (!canReview) {
      return;
    }
    try {
      const inspections = await Promise.all(
        enabledItems.map((item) => api.esp.inspectCustomFlashFile(item.runtimeFilePath))
      );
      const missingItemIndex = inspections.findIndex((inspection) => !inspection.exists);
      if (missingItemIndex >= 0) {
        const missingItem = enabledItems[missingItemIndex];
        throw new Error(
          missingItem.fileSource.kind === "fixed"
            ? `自定义烧录项“${missingItem.name}”的固定文件已失效，请重新选择`
            : `自定义烧录项“${missingItem.name}”的本次文件不存在`
        );
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
      setDraftPlan((current) => ({
        ...current,
        items: current.items.map((item) => ({
          ...item,
          inspection: nextInspections.get(item.id) ?? item.inspection
        }))
      }));
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
    if (summary) {
      onRun({ config, items: summary.requestItems });
    }
  }

  return (
    <section className="panel custom-flash-panel">
      <div className="panel-heading">
        <div>
          <h2>自定义烧录方案</h2>
          <p>方案配置显式保存，本次执行选择不会写回默认值</p>
        </div>
        <FileCheck2 size={20} />
      </div>

      <section className="custom-flash-plan-toolbar" aria-label="方案管理">
        <label className="field">
          <span>已保存方案</span>
          <select
            aria-label="自定义烧录方案"
            value={activePlanId}
            disabled={isRunning || isDirty}
            onChange={(event) => {
              const plan = plans.find((candidate) => candidate.id === event.target.value);
              if (plan) {
                loadPlan(plan);
                onStatus(`已切换到方案“${plan.name}”`);
              }
            }}
          >
            <option value="">未保存的新方案</option>
            {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>方案名称</span>
          <input
            aria-label="方案名称"
            value={draftPlan.name}
            disabled={isRunning}
            onChange={(event) => updatePlan({ name: event.target.value })}
          />
        </label>
        <p className={`custom-flash-save-state ${isDirty ? "dirty" : "saved"}`}>
          {savedPlan === null ? "未保存方案" : isDirty ? "有未保存修改" : "已保存"}
        </p>
        <div className="custom-flash-plan-actions">
          <button type="button" className="command-button" onClick={newPlan} disabled={isRunning || isDirty}>
            <FilePlus2 size={16} />新建方案
          </button>
          <button type="button" className="command-button" onClick={() => void persistPlan(false)} disabled={isRunning || !isDirty}>
            <Save size={16} />保存方案
          </button>
          <button type="button" className="command-button" onClick={() => void persistPlan(true)} disabled={isRunning || savedPlan === null}>
            <CopyPlus size={16} />另存为
          </button>
          <button type="button" className="command-button" onClick={discardChanges} disabled={isRunning || !isDirty}>
            <RotateCcw size={16} />放弃修改
          </button>
          <button type="button" className="command-button danger" onClick={() => void deletePlan()} disabled={isRunning || savedPlan === null || isDirty}>
            <Trash2 size={16} />删除方案
          </button>
        </div>
      </section>

      <div className="custom-flash-list">
        {draftPlan.items.map((item, index) => {
          const position = index + 1;
          const parsedAddress = parseCustomFlashAddress(item.address);
          const fixedFileInvalid = item.fileSource.kind === "fixed" && item.inspection && !item.inspection.exists;
          return (
            <section className="custom-flash-item" key={item.id}>
              <div className="custom-flash-item-heading">
                <label className="switch-row custom-flash-enabled">
                  <input
                    type="checkbox"
                    aria-label={`烧录项 ${position} 临时启用`}
                    checked={item.runtimeEnabled}
                    disabled={isRunning}
                    onChange={(event) => updateItem(item.id, { runtimeEnabled: event.target.checked })}
                  />
                  <span>本次启用 · 烧录项 {position}</span>
                </label>
                <button type="button" className="icon-button" aria-label={`删除烧录项 ${position}`} title="删除烧录项" disabled={isRunning} onClick={() => deleteItem(item.id)}>
                  <Trash2 size={16} />
                </button>
              </div>

              <div className="custom-flash-form">
                <label className="field">
                  <span>名称</span>
                  <input aria-label={`烧录项 ${position} 名称`} value={item.name} disabled={isRunning} onChange={(event) => updateItem(item.id, { name: event.target.value })} />
                </label>
                <label className="field">
                  <span>文件来源</span>
                  <select
                    aria-label={`烧录项 ${position} 文件来源`}
                    value={item.fileSource.kind}
                    disabled={isRunning}
                    onChange={(event) => updateItem(item.id, {
                      fileSource: event.target.value === "fixed" ? { kind: "fixed", filePath: "" } : { kind: "prompt" },
                      runtimeFilePath: "",
                      inspection: null
                    })}
                  >
                    <option value="fixed">固定文件</option>
                    <option value="prompt">每次选择</option>
                  </select>
                </label>
                <label className="field">
                  <span>{item.fileSource.kind === "fixed" ? "固定 BIN" : "本次 BIN"}</span>
                  <div className={`path-control custom-flash-file ${item.fileSource.kind}`}>
                    <input value={item.inspection?.fileName ?? ""} placeholder={item.fileSource.kind === "fixed" ? "请选择固定 BIN" : "执行前选择，不写回方案"} readOnly />
                    <button
                      type="button"
                      className="command-button"
                      aria-label={`烧录项 ${position} ${item.fileSource.kind === "fixed" ? "选择固定 BIN" : "为本次选择 BIN"}`}
                      onClick={() => void chooseFile(item, item.fileSource.kind === "fixed" ? "saved-source" : "runtime")}
                      disabled={isRunning}
                    >
                      <FolderOpen size={16} />
                      {item.fileSource.kind === "fixed" ? "选择固定 BIN" : "为本次选择 BIN"}
                    </button>
                    {item.fileSource.kind === "fixed" && item.fileSource.filePath ? (
                      <button
                        type="button"
                        className="command-button"
                        aria-label={`烧录项 ${position} 仅本次替换 BIN`}
                        onClick={() => void chooseFile(item, "runtime")}
                        disabled={isRunning}
                      >
                        仅本次替换
                      </button>
                    ) : null}
                  </div>
                  {fixedFileInvalid ? <small className="field-error">固定文件已失效，请重新选择</small> : null}
                  {item.runtimeEnabled && item.fileSource.kind === "prompt" && !item.inspection?.exists ? <small className="field-error">本次执行前必须选择文件</small> : null}
                </label>
                <label className="field">
                  <span>十六进制绝对地址</span>
                  <input aria-label={`烧录项 ${position} 十六进制绝对地址`} value={item.address} disabled={isRunning} onChange={(event) => updateItem(item.id, { address: event.target.value })} placeholder="例如 0x10000" />
                  {item.runtimeEnabled && item.address && !parsedAddress.valid ? <small className="field-error">请输入按 4 KiB 对齐的十六进制地址</small> : null}
                </label>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    aria-label={`烧录项 ${position} 默认启用`}
                    checked={item.defaultEnabled}
                    disabled={isRunning}
                    onChange={(event) => updateItem(item.id, { defaultEnabled: event.target.checked })}
                  />
                  <span>方案默认启用</span>
                </label>
              </div>
            </section>
          );
        })}
      </div>

      <button type="button" className="command-button custom-flash-add" onClick={addItem} disabled={isRunning}>
        <Plus size={16} />添加烧录项
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
            <div><dt>方案</dt><dd>{draftPlan.name}</dd></div>
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
          <p className="custom-flash-warning">多项写入不具备事务式回滚，中途失败时设备可能处于部分写入状态</p>
          <div className="danger-row">
            <button type="button" className="action-button primary" onClick={run} disabled={isRunning}>
              <Play size={18} />确认并烧录
            </button>
            <button type="button" className="action-button stop" onClick={onStop} disabled={!isRunning}>
              <Square size={18} />停止
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
