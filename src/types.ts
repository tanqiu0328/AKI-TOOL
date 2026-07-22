import type {
  LowerBoardSimAdapter,
  LowerBoardSimConfig
} from "../shared/lowerBoardSimulation.js";
import type { EspToolAdapter } from "../shared/espToolContract.cjs";

export type {
  LowerBoardSimCommandFrame,
  LowerBoardSimConfig,
  LowerBoardSimFrameEvent,
  LowerBoardSimPortInfo,
  LowerBoardSimStats,
  LowerBoardSimStatusEvent,
  LowerBoardSimStatusFrame,
  SerialConnectionStatus
} from "../shared/lowerBoardSimulation.js";

export type { LowerBoardSimPortInfo as SerialPortInfo } from "../shared/lowerBoardSimulation.js";
export type {
  CustomFlashFileInspection,
  CustomFlashItem,
  CustomFlashRequest,
  EspAction,
  EspActionFinishedEvent as ActionFinishedEvent,
  EspActionOutputEvent as ActionOutputEvent,
  EspConfig,
  EspConfigPayload,
  EspToolAdapter
} from "../shared/espToolContract.cjs";

export type ToolId = "esp" | "lowerBoardSim";

export type AppMeta = {
  name: string;
  version: string;
};

export type AkiApi = {
  getMeta: () => Promise<AppMeta>;
  esp: EspToolAdapter;
  lowerBoardSim: LowerBoardSimAdapter;
  dialog: {
    selectDirectory: () => Promise<string>;
    selectFile: (options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<string>;
  };
  shell: {
    openPath: (targetPath: string) => Promise<string>;
  };
};
