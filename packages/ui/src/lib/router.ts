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

export function go(path: string): void {
  window.location.hash = `#/${path.replace(/^[#/]+/, "")}`;
}
