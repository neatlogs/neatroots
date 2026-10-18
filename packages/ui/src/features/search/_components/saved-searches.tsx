import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { go } from "@/lib/router";
import { useSavedSearches } from "../saved-searches";

export function SavedSearches({ query }: { query: string }) {
  const { items, save } = useSavedSearches();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || (editing === null && !query.trim())) { setError("Enter a name and a query."); return; }
    if (items.some((item) => item.name !== editing && item.name.toLowerCase() === trimmed.toLowerCase())) { setError("A saved query already has this name."); return; }
    const next = editing === null ? [...items, { name: trimmed, query }] : items.map((item) => item.name === editing ? { ...item, name: trimmed } : item);
    if (!save(next)) { setError("Browser storage is unavailable. Your changes were not saved."); return; }
    setName(""); setEditing(null); setError("");
  };
  return <section aria-label="Saved queries" className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground">Saved queries are stored only in this browser.</p>
    <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Input aria-label="Saved query name" placeholder="Query name" className="w-full sm:w-56" value={name} onChange={(event) => setName(event.target.value)} />
      <Button type="submit" variant="outline">{editing === null ? "Save query" : "Save name"}</Button>
      {editing !== null && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setName(""); setError(""); }}>Cancel rename</Button>}
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {items.length > 0 && <ul className="max-h-40 overflow-y-auto rounded-md border border-border">
      {items.map((item) => <li key={item.name} className="flex h-10 items-center gap-1 px-2">
        <Button variant="ghost" className="min-w-0 flex-1 justify-start truncate" onClick={() => { void qc.invalidateQueries({ queryKey: ["search", item.query] }); go(`search?q=${encodeURIComponent(item.query)}`); }}>{item.name}</Button>
        <Button variant="ghost" aria-label={`Rename ${item.name}`} onClick={() => { setEditing(item.name); setName(item.name); setError(""); }}>Rename</Button>
        <Button variant="ghost" aria-label={`Delete ${item.name}`} onClick={() => { if (!save(items.filter((entry) => entry.name !== item.name))) setError("Browser storage is unavailable. Your changes were not saved."); else { if (editing === item.name) { setEditing(null); setName(""); } setError(""); } }}>Delete</Button>
      </li>)}
    </ul>}
  </section>;
}
