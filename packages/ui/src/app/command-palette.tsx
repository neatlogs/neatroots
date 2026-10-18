import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSavedSearches } from "@/features/search/saved-searches";
import { go } from "@/lib/router";

/** Open Search directly when no presets exist; otherwise offer named local queries. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { items } = useSavedSearches();
  const qc = useQueryClient();
  useEffect(() => {
    /** Handle the search shortcut without intercepting other key combinations. */
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (items.length === 0) { go("search"); return; }
        setFilter(""); setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length]);
  /** Refresh only the selected literal query, or the search prefix for generic navigation. */
  const navigate = (path: string, query?: string) => {
    setOpen(false);
    void qc.invalidateQueries({ queryKey: query === undefined ? ["search"] : ["search", query] });
    go(path);
  };
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent>
    <DialogTitle>Search commands</DialogTitle>
    <DialogDescription>Open Search or a query saved in this browser.</DialogDescription>
    <Input aria-label="Find command" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
      <Button variant="ghost" className="justify-start" onClick={() => navigate("search")}>Open Search</Button>
      {items.filter((item) => item.name.toLowerCase().includes(filter.toLowerCase())).map((item) => <Button key={item.name} variant="ghost" className="justify-start truncate" onClick={() => navigate(`search?q=${encodeURIComponent(item.query)}`, item.query)}>Open {item.name}</Button>)}
    </div>
  </DialogContent></Dialog>;
}
