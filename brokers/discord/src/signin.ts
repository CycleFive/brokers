// Discord's side of sign-in: "Sign in with Discord" through the same application's OAuth2
// (scope identify), then an allowlist check on the Discord user ID. The Discord user token is
// used once to read /users/@me and then revoked; it is never stored. The flow itself is
// broker-core's; this file is only what is Discord-specific.

import { VERSION, type Exchanged, type SignInProvider, type WaitUntil } from "broker-core";
import type { Env } from "./env";

export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
export const DISCORD_REVOKE = "https://discord.com/api/oauth2/token/revoke";
export const DISCORD_ME = "https://discord.com/api/v10/users/@me";

export interface AuthProps {
  id: string;
  username: string;
}

/** ALLOWED_DISCORD_USERS: numeric Discord user IDs, comma- or space-separated. */
export function parseAllowlist(raw: string | undefined): { ids: Set<string>; bad: string[] } {
  const ids = new Set<string>();
  const bad: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (/^\d{5,25}$/.test(entry)) ids.add(entry);
    else bad.push(entry);
  }
  return { ids, bad };
}

export function isAllowed(raw: string | undefined, user: { id: string | number }): boolean {
  return parseAllowlist(raw).ids.has(String(user.id));
}

/** Catch the usual configuration mix-ups before sending anyone to Discord, which answers them with an unhelpful page. */
export function configProblem(env: Env): string | null {
  const cid = env.DISCORD_CLIENT_ID ?? "";
  if (cid.includes(".")) {
    return "DISCORD_CLIENT_ID looks like a bot token, not the Application ID. Reset the bot token in the Developer Portal now (it was in a plain var), then set DISCORD_CLIENT_ID to the numeric Application ID.";
  }
  if (!/^\d{15,25}$/.test(cid)) {
    return "DISCORD_CLIENT_ID is not set to the application's numeric Application ID (Developer Portal, General Information, or OAuth2, Client ID).";
  }
  const { ids, bad } = parseAllowlist(env.ALLOWED_DISCORD_USERS);
  if (bad.length) {
    return `ALLOWED_DISCORD_USERS takes numeric Discord user IDs only, but has: ${bad.join(", ")}. In Discord turn on Developer Mode (Settings, Advanced), then right-click your name and Copy User ID.`;
  }
  if (!ids.size) return "ALLOWED_DISCORD_USERS is empty, so nobody could sign in.";
  if (!env.DISCORD_CLIENT_SECRET) return "DISCORD_CLIENT_SECRET is not set (wrangler secret put DISCORD_CLIENT_SECRET).";
  return null;
}

/**
 * Trade a Discord authorization code for the signing-in user's identity. The user token is
 * used once to read /users/@me and then revoked. Shared by the /callback page and the Feed
 * entrypoint, so the client secret stays in this Worker. An empty verifier means no PKCE.
 */
async function exchangeDiscordCode(
  env: Env,
  code: string,
  redirectUri: string,
  verifier: string | undefined,
  ctx: WaitUntil,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<Exchanged<AuthProps>> {
  const basic = `Basic ${btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`)}`;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (verifier) form.set("code_verifier", verifier);
  const tokenRes = await fetchImpl(DISCORD_TOKEN, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": userAgent(env) },
    body: form.toString(),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) {
    console.log(JSON.stringify({ event: "token_exchange_failed", status: tokenRes.status, error: tok.error, description: tok.error_description }));
    const hint =
      tok.error === "invalid_client"
        ? " Check DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (the OAuth2 client secret, not the bot token)."
        : tok.error === "invalid_grant"
          ? " The redirect URI registered on the Discord application must be exactly PUBLIC_URL + /callback."
          : "";
    return { ok: false, status: 502, message: `Discord did not return a token (${tok.error ?? tokenRes.status}${tok.error_description ? `: ${tok.error_description}` : ""}).${hint}` };
  }

  const userRes = await fetchImpl(DISCORD_ME, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json", "User-Agent": userAgent(env) },
  });
  const user = (await userRes.json().catch(() => ({}))) as { id?: string; username?: string };

  // The user token was only needed for /users/@me. Revoke it so nothing lingers.
  ctx.waitUntil(
    fetchImpl(DISCORD_REVOKE, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent(env) },
      body: new URLSearchParams({ token: tok.access_token, token_type_hint: "access_token" }).toString(),
    }).then(
      () => undefined,
      () => undefined,
    ),
  );

  if (!user.id || !user.username) {
    console.log(JSON.stringify({ event: "user_read_failed", status: userRes.status }));
    return { ok: false, status: 502, message: "Could not read your Discord account." };
  }
  return { ok: true, userId: user.id, props: { id: user.id, username: user.username } };
}

export function userAgent(env: Env): string {
  return `DiscordBot (${env.PUBLIC_URL || "https://github.com/cycle-five"}, ${VERSION}) discord-broker`;
}

export const signIn: SignInProvider<Env, AuthProps> = {
  scope: "discord",
  label: "Discord",
  grants: "wants to act as this server's Discord bot: read and post wherever the bot is allowed.",
  configProblem,
  pkce: (env) => env.DISCORD_OAUTH_PKCE === "true",
  authorizeUrl(env, p) {
    const dc = new URL(DISCORD_AUTHORIZE);
    dc.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
    dc.searchParams.set("response_type", "code");
    dc.searchParams.set("redirect_uri", p.redirectUri);
    dc.searchParams.set("scope", "identify");
    dc.searchParams.set("state", p.state);
    if (p.challenge) {
      dc.searchParams.set("code_challenge", p.challenge);
      dc.searchParams.set("code_challenge_method", "S256");
    }
    return dc.toString();
  },
  exchange: (env, p, ctx, fetchImpl) => exchangeDiscordCode(env, p.code, p.redirectUri, p.verifier, ctx, fetchImpl),
  // The allowlist is by Discord user ID alone.
  isAllowed: (env, props) => isAllowed(env.ALLOWED_DISCORD_USERS, { id: props.id }),
  refusal: (u) => `Discord account ${u.username} (ID ${u.id}) is not in ALLOWED_DISCORD_USERS.`,
};
