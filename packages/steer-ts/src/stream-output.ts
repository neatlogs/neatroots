type Obj = Record<string, unknown>;
type Part = { type: "text"; content: string } | { type: "tool_call"; id?: string; name: string; arguments: unknown };
type Message = { role: string; parts: Map<number, Part> };
const object = (value: unknown): Obj => value && typeof value === "object" ? value as Obj : {};
const index = (value: unknown): number => typeof value === "number" ? value : 0;

/** Accumulates observed public provider events only; snapshots replace deltas rather than repeat them. */
export class StreamOutput {
  private messages = new Map<number, Message>();
  constructor(private provider: string) {}

  private message(i: number, role = "assistant"): Message {
    let m = this.messages.get(i);
    if (!m) { m = { role, parts: new Map() }; this.messages.set(i, m); }
    return m;
  }
  private text(m: Message, i: number, value: unknown, replace = false): void {
    if (typeof value !== "string") return;
    const old = m.parts.get(i);
    m.parts.set(i, { type: "text", content: (replace ? "" : old?.type === "text" ? old.content : "") + value });
  }
  private tool(m: Message, i: number): Extract<Part, { type: "tool_call" }> {
    let p = m.parts.get(i);
    if (!p || p.type !== "tool_call") { p = { type: "tool_call", name: "", arguments: "" }; m.parts.set(i, p); }
    return p;
  }
  private snapshot(i: number, item: Obj): void {
    const m = this.message(i, typeof item.role === "string" ? item.role : "assistant");
    if (item.type === "function_call") {
      const p = this.tool(m, 0);
      if (typeof item.call_id === "string") p.id = item.call_id;
      if (typeof item.name === "string") p.name = item.name;
      if (typeof item.arguments === "string") p.arguments = item.arguments;
    } else if (Array.isArray(item.content)) {
      item.content.forEach((part, n) => this.block(m, n, object(part)));
    }
  }
  private block(m: Message, i: number, block: Obj): void {
    if (block.type === "text" || block.type === "output_text") this.text(m, i, block.text, true);
    else if (block.type === "refusal") this.text(m, i, block.refusal, true);
    else if (block.type === "tool_use") {
      const p = this.tool(m, i);
      if (typeof block.id === "string") p.id = block.id;
      if (typeof block.name === "string") p.name = block.name;
      if (block.input !== undefined) p.arguments = structuredClone(block.input);
    }
  }
  add(value: unknown): void {
    const e = object(value);
    if (Array.isArray(e.choices)) {
      for (const choice of e.choices) {
        const c = object(choice), d = object(c.delta), m = this.message(index(c.index));
        if (typeof d.role === "string") m.role = d.role;
        this.text(m, 0, d.content);
        this.text(m, 0, d.refusal);
        if (Array.isArray(d.tool_calls)) for (const call of d.tool_calls) {
          const t = object(call), f = object(t.function), p = this.tool(m, index(t.index) + 1);
          if (typeof t.id === "string") p.id = (p.id ?? "") + t.id;
          if (typeof f.name === "string") p.name += f.name;
          if (typeof f.arguments === "string") p.arguments = String(p.arguments) + f.arguments;
        }
      }
      return;
    }
    if (this.provider === "anthropic") {
      const m = this.message(0);
      if (e.type === "message_start") this.snapshot(0, object(e.message));
      else if (e.type === "content_block_start") this.block(m, index(e.index), object(e.content_block));
      else if (e.type === "content_block_delta") {
        const d = object(e.delta);
        if (d.type === "text_delta") this.text(m, index(e.index), d.text);
        else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          const p = this.tool(m, index(e.index));
          p.arguments = (typeof p.arguments === "string" ? p.arguments : "") + d.partial_json;
        }
      }
      return;
    }
    const type = String(e.type ?? "");
    if (type === "response.output_item.added" || type === "response.output_item.done") this.snapshot(index(e.output_index), object(e.item));
    else if (type === "response.content_part.added" || type === "response.content_part.done") this.block(this.message(index(e.output_index)), index(e.content_index), object(e.part));
    else if (type === "response.output_text.delta" || type === "response.refusal.delta") this.text(this.message(index(e.output_index)), index(e.content_index), e.delta);
    else if (type === "response.output_text.done" || type === "response.refusal.done") this.text(this.message(index(e.output_index)), index(e.content_index), e.text ?? e.refusal, true);
    else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const p = this.tool(this.message(index(e.output_index)), 0);
      if (typeof e.arguments === "string") p.arguments = e.arguments;
      else if (typeof e.delta === "string") p.arguments = String(p.arguments) + e.delta;
    } else if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
      const output = object(e.response).output;
      if (Array.isArray(output)) output.forEach((item, i) => this.snapshot(i, object(item)));
    }
  }
  output(): { role: string; parts: Part[] }[] {
    return [...this.messages].sort(([a], [b]) => a - b).map(([, m]) => ({ role: m.role, parts: [...m.parts].sort(([a], [b]) => a - b).map(([, p]) => ({ ...p })) })).filter((m) => m.parts.length);
  }
}
