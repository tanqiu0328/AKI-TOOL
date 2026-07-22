import type { AkiApi } from "./types";
import { createPreviewLowerBoardSimHarness } from "./previewLowerBoardSim";
import { createPreviewEspToolAdapter } from "./previewEspTool";

function createFallbackApi(): AkiApi {
  const lowerBoardSim = createPreviewLowerBoardSimHarness({ autoInput: true }).adapter;

  return {
    getMeta: async () => ({ name: "AKI-TOOL", version: "0.1.0-preview" }),
    esp: createPreviewEspToolAdapter(),
    lowerBoardSim,
    dialog: {
      selectDirectory: async () => "",
      selectFile: async (options) =>
        options?.filters?.some((filter) => filter.extensions.includes("bin"))
          ? "C:\\AKI-TOOL\\preview\\factory.bin"
          : ""
    },
    shell: {
      openPath: async () => ""
    }
  };
}

export function getAkiApi() {
  return window.aki ?? createFallbackApi();
}
