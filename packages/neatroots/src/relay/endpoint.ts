/** Cloud endpoints neatroots sends a Neatlogs key to as-is: https *.neatlogs.com, or localhost for testing. */
export function allowedEndpoint(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:" && (url.hostname === "neatlogs.com" || url.hostname.endsWith(".neatlogs.com"))) return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Why neatroots won't send a Neatlogs key (or service-account token) to this URL, or null when it
 * will. Anything outside the allow-list (a self-hosted Neatlogs, say) must be https and marked with
 * cloud.trustEndpoint: true in config.yaml, so a typo or a lookalike host never receives a key.
 */
export function endpointProblem(u: string, trusted: boolean): string | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return `the cloud endpoint ${JSON.stringify(u)} isn't a valid URL`;
  }
  if (allowedEndpoint(u)) return null;
  if (url.protocol !== "https:") return `refusing to send a Neatlogs key over plain http to ${url.host}; use an https URL`;
  if (!trusted) return `${url.host} isn't a neatlogs.com address. If it's yours (a self-hosted Neatlogs), set cloud.trustEndpoint: true in config.yaml`;
  return null;
}
