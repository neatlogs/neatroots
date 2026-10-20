type Invoke = (owner: object, original: (...args: unknown[]) => unknown, args: unknown[], path: string) => unknown;
interface Options { telemetry?: unknown }
const originals = new WeakMap<object, { client: object; provider: string; options: Options }>();
const facades = new WeakMap<object, Map<string, Map<unknown, object>>>();

/** Explicit options replace instrumentation; a missing options argument preserves our existing facade. */
export function wrapClient<T extends object>(client: T, provider: string, options: Options | undefined, invoke: Invoke): T {
  const existing = originals.get(client);
  if (existing) {
    if (existing.provider === provider && options === undefined) return client;
    client = existing.client as T;
  }
  const config = options ?? {};
  let providers = facades.get(client);
  if (!providers) facades.set(client, providers = new Map());
  let variants = providers.get(provider);
  if (!variants) providers.set(provider, variants = new Map());
  const hit = variants.get(config.telemetry);
  if (hit) return hit as T;
  const cache = new WeakMap<object, Map<string, object>>();
  let root: T;
  const visit = (target: object, path: string): object => {
    let paths = cache.get(target);
    if (!paths) cache.set(target, paths = new Map());
    const found = paths.get(path);
    if (found) return found;
    const methods = new Map<PropertyKey, unknown>();
    const result = new Proxy(target, {
      get(owner, key, receiver) {
        const value = Reflect.get(owner, key, receiver);
        if (key === "_client" && value === client) return root;
        const childPath = path ? `${path}.${String(key)}` : String(key);
        if (value && typeof value === "object" && ["chat", "chat.completions", "responses", "messages"].includes(childPath)) return visit(value, childPath);
        if (typeof value !== "function") return value;
        if (methods.has(key)) return methods.get(key);
        let method: unknown;
        if (["chat.completions.create", "responses.create", "messages.create"].includes(childPath)) {
          method = (...args: unknown[]) => invoke(owner, value, args, childPath);
        } else if (!path && key === "withOptions") {
          method = (...args: unknown[]) => wrapClient(value.apply(owner, args), provider, options, invoke);
        } else {
          // parse/stream helpers must see this facade's create and _client.
          method = (...args: unknown[]) => value.apply(path ? receiver : owner, args);
        }
        methods.set(key, method);
        return method;
      },
    });
    paths.set(path, result);
    return result;
  };
  root = visit(client, "") as T;
  originals.set(root, { client, provider, options: config });
  variants.set(config.telemetry, root);
  return root;
}
