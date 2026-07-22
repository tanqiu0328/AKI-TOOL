import type { CustomFlashPlan, CustomFlashRequestItem } from "./espToolContract.cjs";

export type ValidatedCustomFlashItem = CustomFlashRequestItem & {
  startAddress: number;
  endAddressExclusive: number;
};

export type CustomFlashAddressResult =
  | { valid: true; value: number }
  | { valid: false; reason: "format" | "alignment" };

export function parseCustomFlashAddress(address: string): CustomFlashAddressResult {
  if (!/^0x[0-9a-f]+$/i.test(address)) {
    return { valid: false, reason: "format" };
  }

  const value = Number.parseInt(address.slice(2), 16);
  if (!Number.isSafeInteger(value) || value % 4096 !== 0) {
    return { valid: false, reason: "alignment" };
  }

  return { valid: true, value };
}

export function getEnabledCustomFlashItems(items: CustomFlashRequestItem[]) {
  const enabledItems = items.filter((item) => item.enabled);

  if (enabledItems.length === 0) {
    throw new Error("请至少启用一个自定义烧录项");
  }

  return enabledItems;
}

export function validateCustomFlashItems(items: CustomFlashRequestItem[]): ValidatedCustomFlashItem[] {
  const validatedItems = getEnabledCustomFlashItems(items).map((item) => {
    const parsedAddress = parseCustomFlashAddress(item.address);
    if (!parsedAddress.valid && parsedAddress.reason === "format") {
      throw new Error(`自定义烧录项“${item.name}”的地址无效: ${item.address}`);
    }
    if (!parsedAddress.valid) {
      throw new Error(`自定义烧录项“${item.name}”的地址必须按 4 KiB 对齐: ${item.address}`);
    }
    if (item.expectedFile.size <= 0) {
      throw new Error(`自定义烧录项“${item.name}”的文件大小必须大于 0 字节`);
    }

    const startAddress = parsedAddress.value;
    const endAddressExclusive = startAddress + item.expectedFile.size;
    if (!Number.isSafeInteger(endAddressExclusive)) {
      throw new Error(`自定义烧录项“${item.name}”的文件大小或地址范围无效`);
    }

    return { ...item, startAddress, endAddressExclusive };
  });

  for (let leftIndex = 0; leftIndex < validatedItems.length; leftIndex += 1) {
    const left = validatedItems[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < validatedItems.length; rightIndex += 1) {
      const right = validatedItems[rightIndex];
      const overlaps = left.startAddress < right.endAddressExclusive && right.startAddress < left.endAddressExclusive;
      if (overlaps) {
        throw new Error(`自定义烧录项“${left.name}”与“${right.name}”的地址范围重叠`);
      }
    }
  }

  return validatedItems;
}

function isAbsoluteFilePath(filePath: string) {
  return /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(filePath);
}

export function validateCustomFlashPlan(plan: CustomFlashPlan): CustomFlashPlan {
  const id = String(plan.id || "").trim();
  const name = String(plan.name || "").trim();
  if (!id) {
    throw new Error("自定义烧录方案缺少标识");
  }
  if (!name) {
    throw new Error("请为自定义烧录方案命名");
  }
  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    throw new Error("自定义烧录方案至少需要一个烧录项");
  }

  const itemIds = new Set<string>();
  const normalizedItems = plan.items.map((item) => {
    const itemId = String(item.id || "").trim();
    const itemName = String(item.name || "").trim();
    if (!itemId || itemIds.has(itemId)) {
      throw new Error("自定义烧录项标识缺失或重复");
    }
    itemIds.add(itemId);
    if (!itemName) {
      throw new Error("自定义烧录项名称不能为空");
    }
    if (!parseCustomFlashAddress(item.address).valid) {
      throw new Error(`自定义烧录项“${itemName}”的地址无效: ${item.address}`);
    }

    if (item.fileSource.kind === "fixed") {
      const filePath = String(item.fileSource.filePath || "").trim();
      if (!isAbsoluteFilePath(filePath)) {
        throw new Error(`自定义烧录项“${itemName}”的固定文件必须使用绝对路径`);
      }
      return {
        id: itemId,
        name: itemName,
        address: item.address,
        defaultEnabled: Boolean(item.defaultEnabled),
        fileSource: { kind: "fixed" as const, filePath }
      };
    }

    return {
      id: itemId,
      name: itemName,
      address: item.address,
      defaultEnabled: Boolean(item.defaultEnabled),
      fileSource: { kind: "prompt" as const }
    };
  });

  return { id, name, items: normalizedItems };
}

export function upsertCustomFlashPlan(plans: CustomFlashPlan[], plan: CustomFlashPlan) {
  const savedPlan = validateCustomFlashPlan(plan);
  const existingIndex = plans.findIndex((candidate) => candidate.id === savedPlan.id);
  const nextPlans = existingIndex >= 0
    ? plans.map((candidate, index) => (index === existingIndex ? savedPlan : candidate))
    : [...plans, savedPlan];
  return { plans: nextPlans, savedPlan };
}

export function removeCustomFlashPlan(plans: CustomFlashPlan[], planId: string) {
  const nextPlans = plans.filter((plan) => plan.id !== planId);
  return { plans: nextPlans, deleted: nextPlans.length !== plans.length };
}
