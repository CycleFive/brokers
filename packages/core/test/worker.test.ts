import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVER_REDIRECT, MemoryKV, cookieHeader, finishSignIn, startSignIn, type SignInDriver } from "broker-core/testing";
import { VERSION } from "../src/version";
import { createBroker, type BaseEnv } from "../src/worker";
import type { SignInProvider } from "../src/signin";

const logs: string[] = [];
vi.spyOn(console, "log").mockImplementation((s: string) => void logs.push(String(s)));
vi.spyOn(console, "warn").mockImplementation(() => {});

type P = { id: string; name: string };
interface TestEnv extends BaseEnv {
  ALLOWED: string;
  BROKEN?: string;
  PKCE?: string;
  CTX_THROWS?: string;
}
let seen: { code: string; redirectUri: string; verifier?: string }[] = [];
let upstream = { authorizeUrl: 0 };
const signIn: SignInProvider<TestEnv, P> = {
  scope: "fake",
  label: "Fake",
  grants: "wants to test.",
  configProblem: (e) => (e.BROKEN ? "BROKEN is set" : null),
  pkce: (e) => e.PKCE === "true",
  authorizeUrl: (_e, p) =>
    (upstream.authorizeUrl++, `https://up.test/authorize?${new URLSearchParams({ state: p.state, redirect_uri: p.redirectUri, ...(p.challenge ? { code_challenge: p.challenge } : {}) })}`),
  exchange: async (_e, p) => {
    seen.push(p);
    return p.code === "bad"
      ? { ok: false, status: 502, message: "Fake did not return a token." }
      : { ok: true, userId: p.code, props: { id: p.code, name: "n" } };
  },
  isAllowed: (e, u) => e.ALLOWED.split(",").includes(u.id),
  refusal: (u) => `Fake account ${u.id} is not allowed.`,
};

let contexts: P[] = [];
const broker = createBroker<TestEnv, P, P>({
  name: "fake-broker",
  title: "Fake broker",
  instructions: "Fake tools.",
  signIn,
  tools: {
    list: [
      {
        name: "whoami",
        title: "Who am I",
        description: "Return the context.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        run: async (_a, ctx) => JSON.stringify(ctx, null, 2),
      },
    ],
    async call(name, _args, ctx) {
      if (name !== "whoami") return null;
      return { content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }], isError: false } as any;
    },
  },
  context: (e, user) => {
    if (e.CTX_THROWS) throw new Error(e.CTX_THROWS);
    contexts.push(user);
    return user;
  },
});

const BASE = "https://broker.test";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const env = (extra: Partial<TestEnv> = {}): TestEnv => ({ OAUTH_KV: new MemoryKV() as unknown as KVNamespace, PUBLIC_URL: BASE, ALLOWED: "u1", ...extra });
const driver = (e: TestEnv): SignInDriver => ({ base: BASE, call: (path, init) => broker.fetch(new Request(BASE + path, init), e, ctx) });
const mcp = (e: TestEnv, token: string, body: unknown) =>
  broker.fetch(
    new Request(BASE + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }),
    e,
    ctx,
  );
const whoami = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } };

async function signedIn(e: TestEnv, code = "u1") {
  const d = driver(e);
  const s = await startSignIn(d);
  return { d, s, ...(await finishSignIn(d, s, code)) };
}

beforeEach(() => {
  logs.length = 0;
  seen = [];
  upstream.authorizeUrl = 0;
  contexts = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("createBroker", () => {
  it("signs in and serves MCP", async () => {
    const e = env();
    const { token } = await signedIn(e);
    expect(token).toBeTruthy();
    const r = (await (await mcp(e, token!, whoami)).json()) as any;
    expect(r.result.content[0].text).toContain('"id": "u1"');
    const root = await broker.fetch(new Request(BASE + "/"), e, ctx);
    expect(await root.text()).toBe(`fake-broker ${VERSION}: MCP endpoint at https://broker.test/mcp\n`);
  });

  it("hands the provider's props to the context unchanged", async () => {
    const e = env();
    const { token } = await signedIn(e);
    await mcp(e, token!, whoami);
    expect(contexts[0]).toEqual({ id: "u1", name: "n" });
  });

  it("re-checks the allowlist on every request", async () => {
    const e = env();
    const { token } = await signedIn(e);
    e.ALLOWED = "";
    expect((await mcp(e, token!, whoami)).status).toBe(403);
  });

  it("stops at the config check before going upstream", async () => {
    const s = await startSignIn(driver(env({ BROKEN: "1" })));
    expect(s.approve.status).toBe(500);
    expect(await s.approve.text()).toContain("BROKEN is set");
    expect(s.approve.headers.get("location")).toBeNull();
    expect(logs.some((l) => l.includes('"config_error"'))).toBe(true);
    expect(upstream.authorizeUrl).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("sends a PKCE challenge only when the provider asks", async () => {
    const off = await signedIn(env());
    expect(new URL(off.s.approve.headers.get("location")!).searchParams.has("code_challenge")).toBe(false);
    expect(seen[0].verifier).toBeFalsy();

    seen = [];
    const on = await signedIn(env({ PKCE: "true" }));
    const challenge = new URL(on.s.approve.headers.get("location")!).searchParams.get("code_challenge");
    expect(challenge).toBeTruthy();
    expect(createHash("sha256").update(seen[0].verifier!).digest("base64url")).toBe(challenge);
  });

  it("refuses an account the provider rejects", async () => {
    const { cb } = await signedIn(env(), "u2");
    expect(cb.status).toBe(403);
    expect(await cb.text()).toContain("Fake account u2 is not allowed.");
    expect(cb.headers.get("location")).toBeNull();
    expect(logs.some((l) => l.includes('"sign_in_refused"'))).toBe(true);
  });

  it("sends a cancelled sign-in back as access_denied", async () => {
    const d = driver(env());
    const s = await startSignIn(d);
    const state = new URL(s.approve.headers.get("location")!).searchParams.get("state")!;
    const cb = await d.call(`/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie: s.cookies } });
    expect(cb.status).toBe(302);
    const loc = cb.headers.get("location")!;
    expect(loc.startsWith("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(new URL(loc).searchParams.get("error")).toBe("access_denied");
    expect(new URL(loc).searchParams.get("error_description")).toBe("Fake sign-in was cancelled");
  });

  it("shows the provider's message when the exchange fails", async () => {
    const { cb } = await signedIn(env(), "bad");
    expect(cb.status).toBe(502);
    expect(await cb.text()).toContain("Fake did not return a token.");
  });

  it("DISABLE_CIMD turns client metadata documents off", async () => {
    // The flag is presented by test-support/workers-flags.ts, as it is in production.
    const meta = async (e: TestEnv) => (await (await driver(e).call("/.well-known/oauth-authorization-server")).json()) as any;
    const on = await meta(env());
    expect(on.client_id_metadata_document_supported).toBe(true);
    expect(on.scopes_supported).toEqual(["fake", "offline_access"]);
    const off = await meta(env({ DISABLE_CIMD: "true" }));
    expect(off.client_id_metadata_document_supported).not.toBe(true);
    expect(off.scopes_supported).toEqual(["fake", "offline_access"]);
  });

  it("an exception becomes a logged 500", async () => {
    const r = await broker.fetch(new Request(BASE + "/"), env({ PUBLIC_URL: "" }), ctx);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("Internal error: PUBLIC_URL is not set\n");
    expect(logs.some((l) => l.includes('"unhandled"'))).toBe(true);
  });

  it("a trailing slash on PUBLIC_URL still gives one issuer", async () => {
    const e = env({ PUBLIC_URL: BASE + "/" });
    const m = (await (await broker.fetch(new Request(BASE + "/.well-known/oauth-authorization-server"), e, ctx)).json()) as any;
    expect(m.issuer).toBe(BASE);
  });

  it("escapes the client's name on the consent page", async () => {
    const s = await startSignIn({ ...driver(env()), clientName: "<script>x</script>" });
    expect(s.html).toContain("&lt;script&gt;");
    expect(s.html).not.toContain("<script>");
  });

  it("logs each library-served OAuth endpoint", async () => {
    const r = await driver(env()).call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "C", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
    });
    expect(r.status).toBe(201);
    expect(logs.map((l) => JSON.parse(l)).some((l) => l.event === "oauth_endpoint" && l.method === "POST" && l.path === "/oauth/register" && l.status === 201)).toBe(true);
  });

  it("answers an unregistered client_id with a 400 page and logs authorize_error", async () => {
    const q = new URLSearchParams({ response_type: "code", client_id: "never-registered", redirect_uri: DRIVER_REDIRECT, scope: "fake", state: "s", resource: `${BASE}/mcp` });
    const r = await driver(env()).call(`/authorize?${q}`);
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(logs.map((l) => JSON.parse(l)).some((l) => l.event === "authorize_error")).toBe(true);
  });

  it("answers an unreachable client metadata document with 502 naming DISABLE_CIMD", async () => {
    const url = "https://client.test/metadata.json";
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetched.push(new Request(input).url);
      throw new Error("network down");
    });
    const q = new URLSearchParams({ response_type: "code", client_id: url, redirect_uri: DRIVER_REDIRECT, scope: "fake", state: "s", resource: `${BASE}/mcp` });
    const r = await driver(env()).call(`/authorize?${q}`);
    expect(fetched).toContain(url);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("DISABLE_CIMD");
    expect(logs.map((l) => JSON.parse(l)).some((l) => l.event === "cimd_fetch_failed" && l.url === url)).toBe(true);
  });

  it("a denied consent goes back to the client and never reaches the provider", async () => {
    const d = driver(env());
    const s = await startSignIn(d);
    const q = new URLSearchParams({
      response_type: "code", client_id: s.client_id, redirect_uri: DRIVER_REDIRECT, scope: "fake offline_access", state: "st9",
      code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: `${BASE}/mcp`,
    });
    const consent = await d.call(`/authorize?${q}`);
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
    upstream.authorizeUrl = 0;
    const r = await d.call("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(consent) },
      body: new URLSearchParams({ handle, decision: "deny" }).toString(),
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(DRIVER_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(upstream.authorizeUrl).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("PUT /authorize is 405", async () => {
    expect((await driver(env()).call("/authorize", { method: "PUT" })).status).toBe(405);
  });

  it("passes ALLOWED_ORIGINS to the MCP endpoint", async () => {
    const e = env({ ALLOWED_ORIGINS: "https://claude.ai" });
    const { token } = await signedIn(e);
    const post = (origin: string) =>
      broker.fetch(
        new Request(BASE + "/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", origin },
          body: JSON.stringify(whoami),
        }),
        e,
        ctx,
      );
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("https://claude.ai")).status).toBe(200);
  });

  it("reports a throwing context as a JSON-RPC error", async () => {
    const e = env();
    const { token } = await signedIn(e);
    e.CTX_THROWS = "X is not set";
    const r = (await (await mcp(e, token!, whoami)).json()) as any;
    expect(r.error.message).toBe("Server not configured: X is not set");
  });
});
