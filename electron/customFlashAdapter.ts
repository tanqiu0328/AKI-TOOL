import type { CustomFlashRequest, EspConfig } from "../shared/espToolContract.cjs";

export type CustomFlashFileMetadata = {
  filePath: string;
  exists: boolean;
  size: number;
  modifiedAtMs: number;
  createdAtMs: number;
};

export type CustomFlashPreflight = {
  flashCapacityBytes: number;
  files: CustomFlashFileMetadata[];
};

export type ElectronCustomFlashAdapterDependencies = {
  inspectFile: (filePath: string) => CustomFlashFileMetadata;
  probeFlashCapacity: (config: EspConfig) => Promise<number>;
  startWrite: (
    request: CustomFlashRequest,
    preflight: CustomFlashPreflight
  ) => Promise<{ id: string }> | { id: string };
};

function formatAddress(value: number) {
  return `0x${value.toString(16)}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertFileMatchesConfirmation(
  item: CustomFlashRequest["items"][number],
  metadata: CustomFlashFileMetadata
) {
  if (!metadata.exists) {
    throw new Error(`自定义烧录项“${item.name}”的文件不存在: ${item.filePath}`);
  }
  if (metadata.size !== item.expectedFile.size) {
    throw new Error(
      `自定义烧录项“${item.name}”的文件大小已变化: ` +
      `确认时 ${item.expectedFile.size} 字节，当前 ${metadata.size} 字节`
    );
  }
  if (metadata.modifiedAtMs !== item.expectedFile.modifiedAtMs ||
      metadata.createdAtMs !== item.expectedFile.createdAtMs) {
    throw new Error(`自定义烧录项“${item.name}”的文件在确认后已被替换或修改: ${item.filePath}`);
  }
}

function fileMetadataChanged(before: CustomFlashFileMetadata, after: CustomFlashFileMetadata) {
  return before.filePath !== after.filePath ||
    before.size !== after.size ||
    before.modifiedAtMs !== after.modifiedAtMs ||
    before.createdAtMs !== after.createdAtMs;
}

export function createElectronCustomFlashAdapter(dependencies: ElectronCustomFlashAdapterDependencies) {
  return {
    async runCustomFlash(request: CustomFlashRequest) {
      const items = request.items.filter((item) => item.enabled);
      const confirmedFiles = items.map((item) => dependencies.inspectFile(item.filePath));
      items.forEach((item, index) => assertFileMatchesConfirmation(item, confirmedFiles[index]));
      let flashCapacityBytes: number;
      try {
        flashCapacityBytes = await dependencies.probeFlashCapacity(request.config);
      } catch (error) {
        throw new Error(
          `无法读取目标设备实际 Flash 容量: ${getErrorMessage(error)}。` +
          "请检查串口连接，并确认设备已进入正确的下载模式"
        );
      }
      const files = items.map((item) => dependencies.inspectFile(item.filePath));

      items.forEach((item, index) => {
        assertFileMatchesConfirmation(item, files[index]);
        if (fileMetadataChanged(confirmedFiles[index], files[index])) {
          throw new Error(`自定义烧录项“${item.name}”的文件在确认后已被替换或修改: ${item.filePath}`);
        }
      });

      items.forEach((item, index) => {
        const startAddress = Number.parseInt(item.address.slice(2), 16);
        const endAddressExclusive = startAddress + files[index].size;
        if (endAddressExclusive > flashCapacityBytes) {
          throw new Error(
            `实际 Flash 容量 ${formatAddress(flashCapacityBytes)}（${flashCapacityBytes} 字节），` +
            `自定义烧录项“${item.name}”的地址范围 ` +
            `${formatAddress(startAddress)}–${formatAddress(endAddressExclusive - 1)} 越界`
          );
        }
      });

      return dependencies.startWrite(request, { flashCapacityBytes, files });
    }
  };
}
