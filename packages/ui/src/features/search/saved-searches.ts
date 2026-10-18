import { useEffect, useState } from "react";

export interface SavedSearch { name: string; query: string }
const KEY = "neatroots.saved-searches.v1";
const EVENT = "neatroots:saved-searches";
function read(): SavedSearch[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    const names = new Set<string>();
    return value.filter((item): item is SavedSearch => {
      if (!item || typeof item.name !== "string" || !item.name.trim() || typeof item.query !== "string" || !item.query.trim() || names.has(item.name.trim().toLowerCase())) return false;
      names.add(item.name.trim().toLowerCase());
      return true;
    }).map(({ name, query }) => ({ name: name.trim(), query }));
  } catch { return []; }
}
export function useSavedSearches() {
  const [items, setItems] = useState(read);
  useEffect(() => {
    const refresh = () => setItems(read());
    window.addEventListener("storage", refresh);
    window.addEventListener(EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(EVENT, refresh); };
  }, []);
  const save = (next: SavedSearch[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      setItems(next);
      window.dispatchEvent(new Event(EVENT));
      return true;
    } catch { return false; }
  };
  return { items, save };
}
