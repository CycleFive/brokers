// GitHub's side of sign-in: "Sign in with GitHub" through the same GitHub App's user
// authorization, then an allowlist check on the GitHub account. The GitHub user token is
// used once to read /user and then revoked; it is never stored. The flow itself is
// broker-core's; this file is only what is GitHub-specific.

import type { SignInProvider } from "broker-core";
import type { Env } from "./env";

export interface AuthProps {
  login: string;
  id: string;
}

/**
 * ALLOWED_GITHUB_USERS is a comma- or space-separated list. Numeric entries match the
 * GitHub user ID (stable across renames, preferred); other entries match the login,
 * case-insensitively.
 */
export function parseAllowlist(raw: string | undefined): { ids: Set<string>; logins: Set<string> } {
  const ids = new Set<string>();
  const logins = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+$/.test(entry)) ids.add(entry);
    else logins.add(entry.toLowerCase());
  }
  return { ids, logins };
}

export function isAllowed(raw: string | undefined, user: { id: string | number; login: string }): boolean {
  const { ids, logins } = parseAllowlist(raw);
  return ids.has(String(user.id)) || logins.has(user.login.toLowerCase());
}

/** Catch the usual configuration mix-ups before sending anyone to GitHub. */
export function configProblem(env: Env): string | null {
  if (!env.GITHUB_APP_CLIENT_ID) return "GITHUB_APP_CLIENT_ID is not set to the GitHub App's client ID (Iv23...).";
  const { ids, logins } = parseAllowlist(env.ALLOWED_GITHUB_USERS);
  if (!ids.size && !logins.size) return "ALLOWED_GITHUB_USERS is empty, so nobody could sign in.";
  if (!env.GITHUB_APP_CLIENT_SECRET) return "GITHUB_APP_CLIENT_SECRET is not set (wrangler secret put GITHUB_APP_CLIENT_SECRET).";
  return null;
}

export const signIn: SignInProvider<Env, AuthProps> = {
  scope: "github",
  label: "GitHub",
  grants: "wants to use this server's GitHub App installation: everything the app is permitted to do on its repositories.",
  configProblem,
  pkce: () => true,
  authorizeUrl(env, p) {
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
    gh.searchParams.set("redirect_uri", p.redirectUri);
    gh.searchParams.set("state", p.state);
    gh.searchParams.set("allow_signup", "false");
    gh.searchParams.set("code_challenge", p.challenge!);
    gh.searchParams.set("code_challenge_method", "S256");
    return gh.toString();
  },
  async exchange(env, p, ctx, fetchImpl = (...a) => fetch(...a)) {
    const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "github-broker-worker" },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code: p.code,
        redirect_uri: p.redirectUri,
        code_verifier: p.verifier,
      }),
    });
    const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!tok.access_token) return { ok: false, status: 502, message: `GitHub did not return a token (${tok.error ?? tokenRes.status}).` };

    const userRes = await fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "github-broker-worker",
      },
    });
    const user = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string };

    // The user token was only needed for /user. Revoke it so nothing lingers.
    ctx.waitUntil(
      fetchImpl(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/token`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`)}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "github-broker-worker",
        },
        body: JSON.stringify({ access_token: tok.access_token }),
      }).then(
        () => undefined,
        () => undefined,
      ),
    );

    if (!user.id || !user.login) return { ok: false, status: 502, message: "Could not read your GitHub account." };
    return { ok: true, userId: String(user.id), props: { login: user.login, id: String(user.id) } };
  },
  isAllowed: (env, props) => isAllowed(env.ALLOWED_GITHUB_USERS, props),
  refusal: (u) => `GitHub account ${u.login} is not allowed on this server.`,
};
