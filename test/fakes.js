// In-memory stand-ins for the Cloudflare bindings the Worker uses. No network, no real accounts.

/** Fake R2 bucket (env.BUCKET). `pageSize` is small on purpose so list() pagination gets exercised. */
export class FakeR2 {
  constructor({ pageSize = 2 } = {}) {
    this.store = new Map(); // key -> Uint8Array
    this.pageSize = pageSize;
    this.listCalls = 0;
  }
  async put(key, body) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    this.store.set(key, bytes.slice());
  }
  async get(key) {
    const b = this.store.get(key);
    return b ? { body: b, size: b.byteLength } : null;
  }
  async head(key) {
    const b = this.store.get(key);
    return b ? { key, size: b.byteLength } : null;
  }
  async list({ prefix = "", cursor } = {}) {
    this.listCalls++;
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    const truncated = next < keys.length;
    return {
      objects: page.map((k) => ({ key: k, size: this.store.get(k).byteLength })),
      truncated,
      ...(truncated ? { cursor: String(next) } : {}),
    };
  }
}

/** Fake KV namespace (env.AUTH). Only the get(key, "json") form is used by the Worker. */
export class FakeKV {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  }
  async get(key, type) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
}

export const BASE = "https://relay.test";

export function makeEnv(tokens = { good: { uid: "me" } }, opts) {
  const auth = {};
  for (const [tok, rec] of Object.entries(tokens)) auth["tok:" + tok] = rec;
  return { BUCKET: new FakeR2(opts), AUTH: new FakeKV(auth) };
}

export function req(method, path, { token = "good", body, headers = {} } = {}) {
  const h = { ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  return new Request(BASE + path, { method, headers: h, body });
}
