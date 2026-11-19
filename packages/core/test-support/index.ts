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

/** Fold a response's Set-Cookie headers into a request Cookie header value. */
export function cookieHeader(res: Response, prior = ""): string {
  const jar = new Map(prior.split("; ").filter(Boolean).map((c) => c.split("=", 2) as [string, string]));
  for (const sc of res.headers.getSetCookie()) {
    const [nv] = sc.split(";");
    const i = nv.indexOf("=");
    jar.set(nv.slice(0, i), nv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export const DRIVER_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export interface SignInDriver {
  /** Send a request to the Worker under test. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /** Base URL of the Worker, no trailing slash. */
  base: string;
  clientName?: string;
}

/**
 * Drive the OAuth flow up to the approval: register a client, fetch the consent page, approve.
 * Returns what each step answered so a test can look at any of them.
 */
export async function startSignIn(d: SignInDriver) {
  const reg = await d.call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: d.clientName ?? "Claude", redirect_uris: [DRIVER_REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: DRIVER_REDIRECT,
    scope: "fake offline_access",
    state: "st8",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${d.base}/mcp`,
  });
  const consent = await d.call(`/authorize?${q}`);
  const html = await consent.clone().text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const cookies = cookieHeader(consent);
  const approve = await d.call("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ handle, decision: "approve" }).toString(),
  });
  return { client_id, verifier, consent, html, approve, cookies: cookieHeader(approve, cookies) };
}

/** Finish the flow from an approved start: call /callback with the upstream code and, if it redirects with a code, redeem it. */
export async function finishSignIn(d: SignInDriver, s: Awaited<ReturnType<typeof startSignIn>>, upstreamCode: string) {
  const up = new URL(s.approve.headers.get("location")!);
  const cb = await d.call(`/callback?code=${encodeURIComponent(upstreamCode)}&state=${encodeURIComponent(up.searchParams.get("state")!)}`, {
    headers: { cookie: s.cookies },
  });
  const back = cb.headers.get("location") ? new URL(cb.headers.get("location")!) : null;
  const code = back?.searchParams.get("code");
  if (!code) return { cb, token: null as string | null };
  const tok = await d.call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: DRIVER_REDIRECT,
      client_id: s.client_id,
      code_verifier: s.verifier,
      resource: `${d.base}/mcp`,
    }).toString(),
  });
  const t = (await tok.json()) as { access_token?: string };
  return { cb, token: t.access_token ?? null };
}
