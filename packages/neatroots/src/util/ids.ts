import crypto from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Sortable, URL-safe id: time prefix + random suffix, with a short type prefix. */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 9; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = crypto.randomBytes(8);
  let r = "";
  for (const b of rand) r += ALPHABET[b % 32];
  return `${prefix}_${time}${r}`;
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
