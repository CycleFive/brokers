// Sign-in for the MCP endpoint: a consent page, then sign-in with the upstream service
// (through a SignInProvider), then an allowlist check. The upstream user token is used
// once to identify the user and then revoked; it is never stored.

import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { consentPage, errorPage } from "./pages";
import { base64url, publicUrl } from "./util";
import type { BaseEnv } from "./worker";

export type Exchanged<P> = { ok: true; userId: string; props: P } | { ok: false; status: number; message: string };

export interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

export interface SignInProvider<E, P> {
  /** The one OAuth scope this broker grants (besides offline_access). */
  scope: string;
  /** Upstream service name on buttons and messages: "Discord". */
  label: string;
  /** Consent sentence after the client's name. */
  grants: string;
  /** Text describing a configuration mistake, or null when configured. */
  configProblem(env: E): string | null;
  /** Whether to send a PKCE challenge upstream. */
  pkce(env: E): boolean;
  /** The complete upstream authorize URL. */
  authorizeUrl(env: E, p: { redirectUri: string; state: string; challenge?: string }): string;
  /** Trade the upstream code for the user's identity; revoke the user token via ctx.waitUntil. */
  exchange(
    env: E,
    p: { code: string; redirectUri: string; verifier?: string },
    ctx: WaitUntil,
    fetchImpl?: typeof fetch,
  ): Promise<Exchanged<P>>;
  isAllowed(env: E, props: P): boolean;
  refusal(props: P): string;
}

async function sha256b64url(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function randomVerifier(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64url(b);
}

function redirect(location: string, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Location", location);
  return new Response(null, { status: 302, headers: h });
}

function renderAuthError(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    console.log(JSON.stringify({ event: "authorize_error", code: e.code, description: e.description, redirect: Boolean(e.redirectTo) }));
    if (e.redirectTo) return redirect(e.redirectTo);
    return errorPage(e.description, 400);
  }
  if (e instanceof CimdFetchError) {
    // The client identified itself by a metadata URL that this Worker could not fetch.
    console.log(JSON.stringify({ event: "cimd_fetch_failed", url: e.metadataUrl, detail: e.detail }));
    return errorPage(`Could not fetch the client's metadata document (${e.metadataUrl}): ${e.detail}. Setting DISABLE_CIMD="true" makes clients register instead.`, 502);
  }
  console.log(JSON.stringify({ event: "authorize_exception", message: (e as Error)?.message }));
  return errorPage(`Unexpected error: ${(e as Error)?.message ?? String(e)}`, 500);
}

/** GET and POST /authorize. */
export async function handleAuthorize<E extends BaseEnv, P>(
  request: Request,
  env: E,
  oauth: OAuthHelpers,
  signIn: SignInProvider<E, P>,
  title: string,
): Promise<Response> {
  try {
    if (request.method === "GET") {
      const authReq = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      return consentPage(details, consent.handle, consent.headers, { title, label: signIn.label, grants: signIn.grants });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // One scope covers everything; offline_access lets the client refresh without a new sign-in.
    const approved = await oauth.approveConsent(request, handle, { scope: [signIn.scope, "offline_access"] });

    const problem = signIn.configProblem(env);
    if (problem) {
      console.log(JSON.stringify({ event: "config_error", message: problem }));
      return errorPage(problem, 500);
    }
    const pkce = signIn.pkce(env);
    const verifier = pkce ? randomVerifier() : "";
    const up = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const url = signIn.authorizeUrl(env, {
      redirectUri: `${publicUrl(env)}/callback`,
      state: up.state,
      challenge: pkce ? await sha256b64url(verifier) : undefined,
    });
    return redirect(url, up.headers);
  } catch (e) {
    return renderAuthError(e);
  }
}

/** GET /callback from the upstream service. */
export async function handleCallback<E extends BaseEnv, P>(
  request: Request,
  env: E,
  oauth: OAuthHelpers,
  ctx: WaitUntil,
  signIn: SignInProvider<E, P>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<Response> {
  let resumed;
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  } catch (e) {
    return renderAuthError(e);
  }
  const { request: authReq, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    console.log(JSON.stringify({ event: "sign_in_cancelled", error: params.get("error"), description: params.get("error_description") }));
    return redirect(authorizationErrorRedirect(authReq, "access_denied", `${signIn.label} sign-in was cancelled`), headers);
  }

  const id = await signIn.exchange(env, { code, redirectUri: `${publicUrl(env)}/callback`, verifier: data.verifier }, ctx, fetchImpl);
  if (!id.ok) return errorPage(id.message, id.status);
  if (!signIn.isAllowed(env, id.props)) {
    console.log(JSON.stringify({ event: "sign_in_refused", ...id.props }));
    return errorPage(signIn.refusal(id.props), 403);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: authReq,
    userId: id.userId,
    metadata: id.props,
    scope: authReq.scope,
    props: id.props,
  });
  console.log(JSON.stringify({ event: "sign_in", ...id.props, client: authReq.clientId }));
  return redirect(redirectTo, headers);
}
