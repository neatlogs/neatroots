import { useEffect, useState } from "react";

const NAVIGATE_EVENT = "neatroots:navigate";

/** Hash routes: #/home, #/runs/:traceId?project=…&check=…, #/checks, #/settings/:tab. */
function read(): { parts: string[]; query: URLSearchParams } {
  const [path, qs] = window.location.hash.replace(/^#\/?/, "").split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(qs ?? "") };
}

/** Subscribe to the path segments of the current hash route. */
export function useRoute(): string[] {
  return useLocation().parts;
}

/** Return a fresh route snapshot for every activation, including repeated same-hash navigation. */
export function useLocation(): { parts: string[]; query: URLSearchParams } {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    // Native anchors do not emit hashchange when their destination is already current.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (link?.getAttribute("href")?.startsWith("#/") && link.hash === window.location.hash && (!link.target || link.target === "_self") && !link.hasAttribute("download")) on();
    };
    window.addEventListener("hashchange", on);
    window.addEventListener(NAVIGATE_EVENT, on);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener(NAVIGATE_EVENT, on);
      window.removeEventListener("click", onClick);
    };
  }, []);
  return loc;
}

/** Activate a hash route and notify subscribers even when its URL is already current. */
export function go(path: string): void {
  const hash = `#/${path.replace(/^[#/]+/, "")}`;
  if (window.location.hash === hash) window.dispatchEvent(new Event(NAVIGATE_EVENT));
  else window.location.hash = hash;
}
