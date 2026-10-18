import { useEffect, useState } from "react";

/** Hash routes: #/home, #/runs/:traceId?project=…&check=…, #/checks, #/settings/:tab. */
function read(): { parts: string[]; query: URLSearchParams } {
  const [path, qs] = window.location.hash.replace(/^#\/?/, "").split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(qs ?? "") };
}

export function useRoute(): string[] {
  return useLocation().parts;
}

export function useLocation(): { parts: string[]; query: URLSearchParams } {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return loc;
}

/** Navigates to a hash route; replace updates filters without adding a history entry. */
export function go(path: string, { replace = false }: { replace?: boolean } = {}): void {
  const hash = `#/${path.replace(/^[#/]+/, "")}`;
  if (replace) {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else window.location.hash = hash;
}
