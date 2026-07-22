import type { CustomFlashRequestItem } from "./espToolContract.cjs";

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
    if (item.expectedFileSize <= 0) {
      throw new Error(`自定义烧录项“${item.name}”的文件大小必须大于 0 字节`);
    }

    const startAddress = parsedAddress.value;
    const endAddressExclusive = startAddress + item.expectedFileSize;
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
