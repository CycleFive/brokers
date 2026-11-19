import { describe, expect, it } from "vitest";
import { escapeHtml } from "broker-core";
import { configProblem, isAllowed, parseAllowlist, signIn } from "../src/signin";
import type { Env } from "../src/env";

describe("allowlist", () => {
  it("matches numeric IDs exactly and logins case-insensitively", () => {
    const raw = "12345, Lothrop  other";
    expect(parseAllowlist(raw).ids).toEqual(new Set(["12345"]));
    expect(isAllowed(raw, { id: 12345, login: "someone-renamed" })).toBe(true);
    expect(isAllowed(raw, { id: 9, login: "lothrop" })).toBe(true);
    expect(isAllowed(raw, { id: 9, login: "lothrop2" })).toBe(false);
    expect(isAllowed(raw, { id: 123456, login: "x" })).toBe(false);
  });

  it("an empty allowlist lets nobody in", () => {
    expect(isAllowed("", { id: 1, login: "a" })).toBe(false);
    expect(isAllowed(undefined, { id: 1, login: "a" })).toBe(false);
  });
});

it("escapes client-supplied strings for the consent page", () => {
  expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

describe("configuration checks before sending anyone to GitHub", () => {
  const base = { GITHUB_APP_CLIENT_ID: "Iv23x", ALLOWED_GITHUB_USERS: "4242", GITHUB_APP_CLIENT_SECRET: "s" } as Env;
  it("passes a sane config", () => expect(configProblem(base)).toBeNull());
  it("spots a missing client ID", () => expect(configProblem({ ...base, GITHUB_APP_CLIENT_ID: "" })).toMatch(/GITHUB_APP_CLIENT_ID/));
  it("spots an empty allowlist", () => expect(configProblem({ ...base, ALLOWED_GITHUB_USERS: " " })).toMatch(/nobody could sign in/));
  it("spots a missing client secret", () => expect(configProblem({ ...base, GITHUB_APP_CLIENT_SECRET: "" })).toMatch(/wrangler secret put/));
});

describe("the GitHub sign-in provider", () => {
  const env = { GITHUB_APP_CLIENT_ID: "Iv23x", GITHUB_APP_CLIENT_SECRET: "s", ALLOWED_GITHUB_USERS: "4242", PUBLIC_URL: "https://b.test" } as Env;
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  function fake(answers: { token: unknown; user?: unknown }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://github.com/login/oauth/access_token") return typeof answers.token === "string" ? new Response(answers.token) : json(answers.token);
      if (url === "https://api.github.com/user") return json(answers.user);
      if (url.startsWith("https://api.github.com/applications/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return Object.assign(fetchImpl, { calls });
  }

  it("keeps the props and scope that stored sign-ins rely on", async () => {
    expect(signIn.scope).toBe("github");
    const r = await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback", verifier: "v" }, ctx, fake({ token: { access_token: "t" }, user: { id: 4242, login: "lothrop" } }));
    expect(r).toEqual({ ok: true, userId: "4242", props: { login: "lothrop", id: "4242" } });
  });

  it("answers a token refusal with its own message, not a crash", async () => {
    const r = await signIn.exchange(env, { code: "c", redirectUri: "u", verifier: "v" }, ctx, fake({ token: "not json" }));
    expect(r).toMatchObject({ ok: false, status: 502, message: "GitHub did not return a token (200)." });
  });

  it("sends the PKCE verifier and revokes the user token afterwards", async () => {
    const f = fake({ token: { access_token: "t" }, user: { id: 4242, login: "lothrop" } });
    await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback", verifier: "v" }, ctx, f);
    await Promise.all(waited);
    expect(JSON.parse(String(f.calls[0].init!.body))).toEqual({ client_id: "Iv23x", client_secret: "s", code: "c", redirect_uri: "https://b.test/callback", code_verifier: "v" });
    const revoke = f.calls.find((c) => c.url === "https://api.github.com/applications/Iv23x/token")!;
    expect(revoke.init!.method).toBe("DELETE");
    expect(JSON.parse(String(revoke.init!.body))).toEqual({ access_token: "t" });
  });

  it("builds the authorize URL with PKCE and no sign-ups", () => {
    const u = new URL(signIn.authorizeUrl(env, { redirectUri: "https://b.test/callback", state: "s1", challenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "Iv23x", redirect_uri: "https://b.test/callback", state: "s1", allow_signup: "false", code_challenge: "ch", code_challenge_method: "S256" });
  });

  it("allows by ID or login and words the refusal", () => {
    expect(signIn.isAllowed(env, { id: "4242", login: "x" })).toBe(true);
    expect(signIn.isAllowed(env, { id: "1", login: "x" })).toBe(false);
    expect(signIn.refusal({ id: "1", login: "x" })).toBe("GitHub account x is not allowed on this server.");
  });
});
