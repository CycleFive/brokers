// End-to-end through the real Worker entry point and the real OAuth library:
// client registration -> consent -> GitHub sign-in (mocked) -> token -> MCP calls.
// GitHub is faked at the fetch layer; KV is in memory.

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV } from "broker-core/testing";
import worker from "../src/index";
import type { Env } from "../src/env";
import { TEST_PEM, jsonRes } from "./fake-github";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const BASE = "https://broker.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function env(allowed = "4242"): Env {
  return {
    OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
    PUBLIC_URL: BASE,
    GITHUB_APP_CLIENT_ID: "Iv23liFlowTest",
    GITHUB_INSTALLATION_ID: "1",
    GITHUB_DEFAULT_OWNER: "o",
    ALLOWED_GITHUB_USERS: allowed,
    GITHUB_APP_PRIVATE_KEY: TEST_PEM,
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  };
}

const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

const call = (e: Env, path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, init), e, ctx);

function cookieHeader(res: Response, prior = ""): string {
  const jar = new Map(prior.split("; ").filter(Boolean).map((c) => c.split("=", 2) as [string, string]));
  for (const sc of res.headers.getSetCookie()) {
    const [nv] = sc.split(";");
    const i = nv.indexOf("=");
    jar.set(nv.slice(0, i), nv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

let githubCalls: { url: string; init?: RequestInit }[] = [];
let githubUser = { id: 4242, login: "Lothrop" };

beforeEach(() => {
  githubCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    githubCalls.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token") return jsonRes({ access_token: "ghu_user_token", token_type: "bearer" });
    if (url === "https://api.github.com/user") return jsonRes(githubUser);
    if (url.startsWith("https://api.github.com/applications/")) return new Response(null, { status: 204 });
    if (url === "https://api.github.com/app/installations/1/access_tokens")
      return jsonRes({ token: "ghs_inst", expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: { workflows: "write" } }, 201);
    return jsonRes({ message: "Not Found" }, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function signIn(e: Env, withResource = true) {
  const reg = await call(e, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    scope: "github offline_access",
    state: "st8",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (withResource) q.set("resource", `${BASE}/mcp`);
  const consent = await call(e, `/authorize?${q}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("<code>claude.ai</code>");
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  let cookies = cookieHeader(consent);

  const approve = await call(e, "/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ handle, decision: "approve" }).toString(),
  });
  expect(approve.status).toBe(302);
  const gh = new URL(approve.headers.get("location")!);
  expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(gh.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
  cookies = cookieHeader(approve, cookies);

  const cb = await call(e, `/callback?code=gh_code&state=${encodeURIComponent(gh.searchParams.get("state")!)}`, { headers: { cookie: cookies } });
  return { cb, client_id, verifier, githubVerifierChallenge: gh.searchParams.get("code_challenge") };
}

describe("OAuth metadata", () => {
  it("advertises the same scopes and endpoints as before", async () => {
    const m = (await (await call(env(), "/.well-known/oauth-authorization-server")).json()) as Record<string, any>;
    expect(m.issuer).toBe(BASE);
    expect(m.scopes_supported).toEqual(["github", "offline_access"]);
    expect(m.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${BASE}/oauth/register`);
    expect(m.authorization_endpoint).toBe(`${BASE}/authorize`);
  });
});

describe("full sign-in and MCP flow", () => {
  it.each([true, false])("issues a token to an allowlisted user and serves MCP with it (resource param: %s)", async (withResource) => {
    const e = env();
    const { cb, client_id, verifier, githubVerifierChallenge } = await signIn(e, withResource);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st8");
    const code = back.searchParams.get("code")!;

    // GitHub code exchange carried the PKCE verifier matching the challenge we sent.
    const exch = githubCalls.find((c) => c.url === "https://github.com/login/oauth/access_token")!;
    const sent = JSON.parse(String(exch.init!.body));
    expect(createHash("sha256").update(sent.code_verifier).digest("base64url")).toBe(githubVerifierChallenge);
    // The GitHub user token gets revoked after /user.
    await Promise.all(waits);
    expect(githubCalls.some((c) => c.url.startsWith("https://api.github.com/applications/") && c.init?.method === "DELETE")).toBe(true);

    const tok = await call(e, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier, ...(withResource ? { resource: `${BASE}/mcp` } : {}) }).toString(),
    });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token?: string; scope: string };
    expect(t.access_token).toBeTruthy();
    expect(t.refresh_token).toBeTruthy();

    const mcp = (body: unknown) =>
      call(e, "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
    const list = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    expect(list.result.tools.length).toBeGreaterThan(5);
    const info = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "installation_info", arguments: {} } })).json()) as any;
    expect(info.result.isError).toBe(false);
    expect(info.result.content[0].text).toContain('"signed_in_as": "Lothrop"');

    // Removing the user from the allowlist cuts off an already-issued token.
    e.ALLOWED_GITHUB_USERS = "999";
    expect((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(403);

    // A garbage token is a 401 challenge.
    const bad = await call(e, "/mcp", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);
  });

  it("refuses a GitHub account that is not on the allowlist", async () => {
    githubUser = { id: 7, login: "stranger" };
    const e = env();
    const { cb } = await signIn(e);
    expect(cb.status).toBe(403);
    expect(await cb.text()).toContain("not allowed");
    githubUser = { id: 4242, login: "Lothrop" };
  });
});

describe("hardening gained from broker-core", () => {
  it("explains an empty allowlist instead of sending you to GitHub", async () => {
    const e = env("");
    const reg = await call(e, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, scope: "github offline_access", state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    const consent = await call(e, `/authorize?${q}`);
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
    const approve = await call(e, "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(consent) },
      body: new URLSearchParams({ handle, decision: "approve" }).toString(),
    });
    expect(approve.status).toBe(500);
    expect(await approve.text()).toContain("nobody could sign in");
    expect(approve.headers.get("location")).toBeNull();
  });

  it("answers an exception with a logged 500", async () => {
    const e = { ...env(), PUBLIC_URL: "" };
    const res = await call(e, "/");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error: PUBLIC_URL is not set\n");
  });
});
