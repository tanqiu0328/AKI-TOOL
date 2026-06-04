import type { AkiApi } from "./types";

declare global {
  interface Window {
    aki?: AkiApi;
  }
}

export {};
