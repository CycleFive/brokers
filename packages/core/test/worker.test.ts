import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, cookieHeader, finishSignIn, startSignIn, type SignInDriver } from "broker-core/testing";
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
}
let seen: { code: string; redirectUri: string; verifier?: string }[] = [];
const signIn: SignInProvider<TestEnv, P> = {
  scope: "fake",
  label: "Fake",
  grants: "wants to test.",
  configProblem: (e) => (e.BROKEN ? "BROKEN is set" : null),
  pkce: (e) => e.PKCE === "true",
  authorizeUrl: (_e, p) =>
    `https://up.test/authorize?${new URLSearchParams({ state: p.state, redirect_uri: p.redirectUri, ...(p.challenge ? { code_challenge: p.challenge } : {}) })}`,
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
  context: (_e, user) => {
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
});
