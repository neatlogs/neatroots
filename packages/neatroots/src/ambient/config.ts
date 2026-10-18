import { CHROMA_DEVICES, chromaDevices, type ChromaDevice } from "./chroma-frames.js";
import type { AmbientConfig } from "./types.js";
export function normalizeAmbient(value: AmbientConfig | undefined): AmbientConfig {
  const c = value?.outputs?.chroma;
  const valid = c?.devices === undefined || (Array.isArray(c.devices) && c.devices.length > 0 && c.devices.every(d => CHROMA_DEVICES.includes(d)));
  return { enabled: value?.enabled === true, outputs: {
    log: { enabled: value?.outputs?.log?.enabled === true },
    chroma: { enabled: c?.enabled === true && valid && (c.animation === undefined || typeof c.animation === "boolean"),
      animation: c?.animation === true, devices: valid ? [...chromaDevices(c?.devices as ChromaDevice[] | undefined)] : ["chromalink"] },
  } };
}
