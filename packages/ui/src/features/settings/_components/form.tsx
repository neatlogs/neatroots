import { useState, type ReactNode } from "react";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A labelled control with an optional hint under it. */
export function SettingField({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </FieldLabel>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Field>
  );
}

/** The app Select for a fixed list of options. */
export function OptionSelect({
  id,
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  id?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  label?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(String(v))}>
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Paste a key, store it in the Keychain, or remove the stored one. The key is never shown again. */
export function KeyInput({
  id,
  label,
  stored,
  storing,
  onStore,
  onRemove,
  noun = "key",
  placeholder = "Paste your API key",
}: {
  id: string;
  label: string;
  stored: boolean;
  storing: boolean;
  onStore: (key: string, done: () => void) => void;
  onRemove?: () => void;
  /** What is being stored, for the button labels ("Store token"). */
  noun?: string;
  placeholder?: string;
}) {
  const [key, setKey] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input id={id} aria-label={label} type="password" className="h-8 min-w-0 flex-1" placeholder={stored ? `${noun[0].toUpperCase()}${noun.slice(1)} stored` : placeholder} value={key} onChange={(e) => setKey(e.target.value)} />
      <PendingButton size="sm" variant="secondary" className="shrink-0" disabled={key.length < 8} pending={storing} onClick={() => onStore(key, () => setKey(""))}>
        Store {noun}
      </PendingButton>
      {stored && onRemove && (
        <Button size="sm" variant="ghost" className="shrink-0 text-danger-fg" onClick={onRemove}>
          Remove {noun}
        </Button>
      )}
    </div>
  );
}
