import { describe, expect, it } from "vitest";
import { escapeHtml } from "broker-core";
import { DISCORD_ME, DISCORD_REVOKE, DISCORD_TOKEN, configProblem, isAllowed, parseAllowlist, signIn } from "../src/signin";
import type { Env } from "../src/env";

describe("allowlist", () => {
  it("matches numeric Discord IDs exactly and nothing else", () => {
    const raw = "800000000000000001, lothrop  800000000000000003";
    expect(parseAllowlist(raw).ids).toEqual(new Set(["800000000000000001", "800000000000000003"]));
    expect(parseAllowlist(raw).bad).toEqual(["lothrop"]);
    expect(isAllowed(raw, { id: "800000000000000001" })).toBe(true);
    expect(isAllowed(raw, { id: "80000000000000000" })).toBe(false);
  });

  it("an empty allowlist lets nobody in", () => {
    expect(isAllowed("", { id: "1" })).toBe(false);
    expect(isAllowed(undefined, { id: "1" })).toBe(false);
  });
});

describe("configuration checks before sending anyone to Discord", () => {
  const base = { DISCORD_CLIENT_ID: "123456789012345678", ALLOWED_DISCORD_USERS: "800000000000000001", DISCORD_CLIENT_SECRET: "s" } as Env;
  it("passes a sane config", () => expect(configProblem(base)).toBeNull());
  it("spots a bot token pasted as the client ID", () => expect(configProblem({ ...base, DISCORD_CLIENT_ID: "MTk4.Cl2FMQ.ZnCj" })).toMatch(/bot token/));
  it("spots a placeholder client ID", () => expect(configProblem({ ...base, DISCORD_CLIENT_ID: "REPLACE" })).toMatch(/Application ID/));
  it("spots a username in the allowlist", () => expect(configProblem({ ...base, ALLOWED_DISCORD_USERS: "lothrop" })).toMatch(/Copy User ID/));
  it("spots a missing client secret", () => expect(configProblem({ ...base, DISCORD_CLIENT_SECRET: "" })).toMatch(/DISCORD_CLIENT_SECRET/));
});

it("escapes client-supplied strings for the consent page", () => {
  expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

describe("the Discord sign-in provider", () => {
  const env = { DISCORD_CLIENT_ID: "123456789012345678", DISCORD_CLIENT_SECRET: "s", ALLOWED_DISCORD_USERS: "800000000000000001", PUBLIC_URL: "https://b.test" } as Env;
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  function fake(answers: { token: unknown; me: unknown }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === DISCORD_TOKEN) return json(answers.token);
      if (url === DISCORD_ME) return json(answers.me);
      if (url === DISCORD_REVOKE) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return Object.assign(fetchImpl, { calls });
  }

  it("keeps the props and scope that stored sign-ins rely on", async () => {
    expect(signIn.scope).toBe("discord");
    const fetchImpl = fake({ token: { access_token: "t" }, me: { id: "800000000000000001", username: "lothrop" } });
    const r = await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback" }, ctx, fetchImpl);
    expect(r).toEqual({ ok: true, userId: "800000000000000001", props: { id: "800000000000000001", username: "lothrop" } });
  });

  it("revokes the user token after reading the account", async () => {
    const fetchImpl = fake({ token: { access_token: "t" }, me: { id: "800000000000000001", username: "lothrop" } });
    await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback" }, ctx, fetchImpl);
    await Promise.all(waited);
    const rev = fetchImpl.calls.find((c) => c.url === DISCORD_REVOKE)!;
    expect(new URLSearchParams(String(rev.init!.body)).get("token")).toBe("t");
  });

  it("treats an empty verifier as no PKCE", async () => {
    const fetchImpl = fake({ token: { access_token: "t" }, me: { id: "800000000000000001", username: "lothrop" } });
    await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback", verifier: "" }, ctx, fetchImpl);
    expect(new URLSearchParams(String(fetchImpl.calls[0].init!.body)).has("code_verifier")).toBe(false);
    const f2 = fake({ token: { access_token: "t" }, me: { id: "800000000000000001", username: "lothrop" } });
    await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback", verifier: "v" }, ctx, f2);
    expect(new URLSearchParams(String(f2.calls[0].init!.body)).get("code_verifier")).toBe("v");
  });

  it("decides the allowlist on the user ID alone", () => {
    expect(signIn.isAllowed(env, { id: "800000000000000001", username: "anyone" })).toBe(true);
    expect(signIn.isAllowed(env, { id: "800000000000000009", username: "800000000000000001" })).toBe(false);
  });

  it("builds the Discord authorize URL, with PKCE parameters only when given a challenge", () => {
    const base = { redirectUri: "https://b.test/callback", state: "st" };
    const plain = new URL(signIn.authorizeUrl(env, base));
    expect(plain.origin + plain.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(plain.searchParams)).toEqual({ client_id: "123456789012345678", response_type: "code", redirect_uri: "https://b.test/callback", scope: "identify", state: "st" });
    const pkce = new URL(signIn.authorizeUrl(env, { ...base, challenge: "ch" }));
    expect(pkce.searchParams.get("code_challenge")).toBe("ch");
    expect(pkce.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
