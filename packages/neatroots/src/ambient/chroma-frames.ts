import type { AmbientState } from "./types.js";

export const CHROMA_DEVICES = ["chromalink", "keyboard", "mouse", "mousepad", "headset", "keypad"] as const;
export type ChromaDevice = typeof CHROMA_DEVICES[number];
export type ChromaEffect = { effect: "CHROMA_NONE" } | { effect: "CHROMA_STATIC"; param: { color: number } };
const COLORS: Record<Exclude<AmbientState, "inactive" | "idle">, number> = {
  live: 0xffa040, checking: 0xff40c0, loop: 0x00a5ff, error: 0x3030ff,
  interrupted: 0x205080, attention: 0x00ffff, incomplete: 0x808080, success: 0x40cc40,
};

export function chromaDevices(selected: readonly ChromaDevice[] = ["chromalink"]): readonly ChromaDevice[] {
  if (!Array.isArray(selected) || !selected.length || selected.some(device => !CHROMA_DEVICES.includes(device))) {
    throw new Error("Invalid Chroma devices");
  }
  return CHROMA_DEVICES.filter(device => selected.includes(device));
}

function dim(color: number, brightness: number): number {
  return [0, 8, 16].reduce((result, shift) => result | Math.round(((color >>> shift) & 255) * brightness) << shift, 0);
}

/** Pure elapsed-time frames. No SDK animation or run-completion inference. */
export function chromaFrame(state: AmbientState, elapsedMs: number, animation = false): { body: ChromaEffect; moving: boolean } {
  if (state === "inactive" || state === "idle") return { body: { effect: "CHROMA_NONE" }, moving: false };
  const elapsed = Math.max(0, elapsedMs);
  let brightness = 1;
  let moving = false;
  if (animation && (state === "live" || state === "loop")) {
    const period = state === "live" ? 4000 : 1000;
    brightness = 0.25 + 0.75 * (1 - Math.cos(2 * Math.PI * (elapsed % period) / period)) / 2;
    moving = true;
  } else if (animation && state === "success") {
    if (elapsed >= 3000) return { body: { effect: "CHROMA_NONE" }, moving: false };
    brightness = elapsed <= 1200 ? 1 : (3000 - elapsed) / 1800;
    moving = true;
  }
  return { body: { effect: "CHROMA_STATIC", param: { color: dim(COLORS[state], brightness) } }, moving };
}
