import YAML from "yaml";
import { isDeepStrictEqual } from "node:util";

interface FoundCheck { doc: YAML.Document.Parsed; node: YAML.YAMLMap; list?: YAML.YAMLSeq }
interface Edit { start: number; end: number; replacement?: string }
interface Mark { type: string; offset: number; source: string }
type ParsedChecks = { checks: { id: string }[]; errors: { id?: string; message: string }[] };
const selected = (node: unknown, id: string) => YAML.isMap(node) && node.get("id") === id;

function marks(list: YAML.YAMLSeq, index: number): readonly Mark[] {
  const token = list.srcToken;
  if (!token || !("items" in token)) throw new Error("cannot locate check sequence tokens safely");
  return token.items[index]?.start ?? [];
}

/** Ignore offsets, but retain every surviving raw check and the surrounding YAML structure. */
function meaning(text: string, id?: string): unknown[] {
  const shape = (node: unknown): unknown => {
    if (YAML.isAlias(node)) return { alias: node.source };
    if (YAML.isScalar(node)) return { value: node.value, tag: node.tag, anchor: node.anchor };
    if (YAML.isMap(node)) return { map: node.items.map(p => [shape(p.key), shape(p.value)]), tag: node.tag, anchor: node.anchor };
    if (YAML.isSeq(node)) return { seq: node.items.map(shape), tag: node.tag, anchor: node.anchor };
    return null;
  };
  const out: unknown[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    if (doc.errors.length) {
      out.push({ invalid: text.slice(doc.range![0], doc.range![2]) });
      continue;
    }
    const root = doc.contents;
    if (!root || (YAML.isScalar(root) && root.value == null) || (id !== undefined && selected(root, id))) continue;
    const wrapped = YAML.isMap(root) ? root.get("checks", true) : undefined;
    const list = YAML.isSeq(root) ? root : YAML.isSeq(wrapped) ? wrapped : undefined;
    const kept = list?.items.filter(n => id === undefined || !selected(n, id));
    if (YAML.isSeq(root) && !kept!.length) continue;
    const raw = (list ? kept! : [root]).map(n => YAML.isNode(n) && n.range ? text.slice(n.range[0], n.range[1]) : "");
    let structure: unknown = shape(root);
    if (list) {
      const seq = { seq: kept!.map(shape), tag: list.tag, anchor: list.anchor };
      structure = root === list ? seq : { map: (root as YAML.YAMLMap).items.map(p => [shape(p.key), p.value === list ? seq : shape(p.value)]), tag: root.tag, anchor: (root as YAML.YAMLMap).anchor };
    }
    out.push({ structure, raw });
  }
  return out;
}

/** Cut node/token ranges only; check both structure and load results before any disk mutation. */
export function removeCheckText(text: string, id: string, found: FoundCheck[], parse: (text: string) => ParsedChecks): string {
  if (!found.length) return text;
  const edits: Edit[] = [];
  const byList = new Map<YAML.YAMLSeq, FoundCheck[]>();
  for (const entry of found) {
    if (entry.list) {
      const group = byList.get(entry.list) ?? []; group.push(entry); byList.set(entry.list, group);
    } else {
      // Document markers and leading/trailing comments belong to the file, not this map.
      const [start, end] = entry.node.range!;
      const outside = text.slice(entry.doc.range![0], start) + text.slice(end, entry.doc.range![2]);
      edits.push(outside.includes("#") ? { start, end } : { start: entry.doc.range![0], end: entry.doc.range![2] });
      if (outside.includes("#") && (entry.node.anchor || entry.node.tag)) {
        for (const token of new YAML.Parser().parse(text)) {
          if (token.type !== "document" || token.value?.offset !== entry.node.srcToken?.offset) continue;
          for (const property of token.start) if (property.type === "anchor" || property.type === "tag") {
            edits.push({ start: property.offset, end: property.offset + property.source.length });
          }
        }
      }
    }
  }
  for (const [list, group] of byList) {
    const indices = new Set(group.map(f => list.items.indexOf(f.node)));
    for (const index of indices) {
      const node = list.items[index];
      if (!YAML.isNode(node) || !node.range) throw new Error("cannot locate check node safely");
      const tokens = marks(list, index);
      let start = node.range![0];
      if (list.flow) {
        for (const mark of tokens) if (mark.type === "anchor" || mark.type === "tag") start = Math.min(start, mark.offset);
      } else {
        const marker = tokens.find(t => t.type === "seq-item-ind");
        if (!marker) throw new Error("cannot locate check dash safely");
        start = text.lastIndexOf("\n", marker.offset - 1) + 1;
      }
      edits.push({ start, end: node.range![1] });
    }
    if (list.flow) {
      const removeComma = (token: Mark | undefined) => {
        if (!token) return;
        const whitespace = /^[ \t\r\n]*/.exec(text.slice(token.offset + 1))![0].length;
        edits.push({ start: token.offset, end: token.offset + 1 + whitespace });
      };
      // Choose separators per contiguous removed group; no overlapping per-node comma cuts.
      for (let first = 0; first < list.items.length; first++) {
        if (!indices.has(first)) continue;
        let last = first;
        while (indices.has(last + 1)) last++;
        const following = last + 1 < list.items.length;
        for (let i = following ? first + 1 : first; i <= (following ? last + 1 : last); i++) {
          removeComma(marks(list, i).find(t => t.type === "comma"));
        }
        if (!following) {
          const token = list.srcToken!;
          if ("items" in token) for (const item of token.items.slice(list.items.length)) removeComma(item.start.find(t => t.type === "comma"));
        }
        first = last;
      }
    } else if (indices.size === list.items.length) {
      const root = group[0].doc.contents;
      if (YAML.isMap(root)) {
        const index = root.items.findIndex(p => p.value === list);
        const pair = root.items[index];
        if (!pair || !YAML.isNode(pair.key) || !pair.key.range) throw new Error("cannot locate checks wrapper safely");
        const token = root.srcToken;
        const separator = token && "items" in token ? token.items[index]?.sep ?? [] : [];
        const colon = separator.find(t => t.type === "map-value-ind");
        const property = separator.filter(t => t.type === "anchor" || t.type === "tag").at(-1);
        // Keep value properties before the replacement sequence, including multiline properties.
        const at = property ? property.offset + property.source.length : colon ? colon.offset + 1 : -1;
        if (at < 0 || at >= list.range![0]) throw new Error("cannot locate checks wrapper separator safely");
        edits.push({ start: at, end: at, replacement: " []" });
      }
    }
  }
  const merged: Edit[] = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    const prior = merged.at(-1);
    if (prior && edit.start < prior.end && !prior.replacement && !edit.replacement) prior.end = Math.max(prior.end, edit.end);
    else merged.push(edit);
  }
  let out = text;
  for (const edit of merged.reverse()) out = out.slice(0, edit.start) + (edit.replacement ?? "") + out.slice(edit.end);
  const before = parse(text), after = parse(out);
  const errors = (value: ParsedChecks) => value.errors.filter(e => e.id !== id).map(e => ({ id: e.id, message: e.message.replace(/ at line \d+, column \d+:[\s\S]*/, "") }));
  if (!isDeepStrictEqual(meaning(text, id), meaning(out))
    || !isDeepStrictEqual(before.checks.filter(c => c.id !== id), after.checks)
    || !isDeepStrictEqual(errors(before), errors(after))) {
    throw new Error(`can't delete check ${id}: the edit would change another check or load error; file preserved`);
  }
  return out;
}
