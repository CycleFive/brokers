// Test doubles shared by the brokers: imported as "broker-core/testing".

export class MemoryKV {
  m = new Map<string, { v: string; exp?: number; metadata?: unknown }>();
  async get(k: string, type?: any) {
    const e = this.m.get(k);
    if (!e || (e.exp && e.exp < Date.now())) return null;
    const t = typeof type === "string" ? type : type?.type;
    return t === "json" ? JSON.parse(e.v) : e.v;
  }
  async put(k: string, v: string, o?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
    const exp = o?.expirationTtl ? Date.now() + o.expirationTtl * 1000 : o?.expiration ? o.expiration * 1000 : undefined;
    this.m.set(k, { v, exp, metadata: o?.metadata });
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list(o?: { prefix?: string; limit?: number; cursor?: string }) {
    const keys = [...this.m.keys()].filter((k) => !o?.prefix || k.startsWith(o.prefix)).sort();
    return { keys: keys.map((name) => ({ name, metadata: this.m.get(name)!.metadata })), list_complete: true, cursor: "" };
  }
}
