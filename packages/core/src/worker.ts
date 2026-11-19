// The Worker entry point shared by the brokers: OAuth endpoints, sign-in pages and /mcp.
//
//   /mcp                                   MCP endpoint (OAuth bearer required)
//   /.well-known/oauth-protected-resource  RFC 9728 metadata (resource server)
//   /.well-known/oauth-authorization-server, /oauth/token, /oauth/register  (library)
//   /authorize, /callback                  consent page + sign-in with the upstream service

import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  insufficientScope,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { handleMcp, type McpTools } from "./mcp";
import { handleAuthorize, handleCallback, type SignInProvider } from "./signin";
import { publicUrl } from "./util";
import { VERSION } from "./version";

export interface BaseEnv {
  OAUTH_KV: KVNamespace;
  PUBLIC_URL: string;
  ALLOWED_ORIGINS?: string;
  DISABLE_CIMD?: string;
}

export interface BrokerConfig<E extends BaseEnv, P, C> {
  /** "discord-broker": serverInfo.name and the "/" banner. */
  name: string;
  /** "Discord broker": serverInfo.title, resource_name, page headings. */
  title: string;
  instructions: string;
  signIn: SignInProvider<E, P>;
  tools: McpTools<C>;
  /** May throw; handleMcp reports it as "Server not configured: ...". */
  context(env: E, user: P): C;
}

export function createBroker<E extends BaseEnv, P, C>(
  cfg: BrokerConfig<E, P, C>,
): { fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> } {
  const { signIn } = cfg;

  interface Roles {
    key: string;
    as: OAuthAuthorizationServer<E>;
    rs: OAuthResourceServer<E, P>;
  }
  let roles: Roles | undefined;

  function getRoles(env: E): Roles {
    const url = publicUrl(env);
    const key = `${url}|${env.DISABLE_CIMD ?? ""}`;
    if (roles && roles.key === key) return roles;
    const resource = `${url}/mcp`;

    const as = new OAuthAuthorizationServer<E>({
      issuer: url,
      resources: [resource],
      scopesSupported: [signIn.scope, "offline_access"],
      clientRegistrationEndpoint: "/oauth/register",
      // Claude prefers CIMD when advertised. DISABLE_CIMD="true" forces Dynamic Client Registration.
      clientIdMetadataDocumentEnabled: env.DISABLE_CIMD !== "true",
      accessTokenTTL: 3600,
    });

    const rs = new OAuthResourceServer<E, P>({
      resourceMetadata: { resource, authorization_servers: [url], resource_name: cfg.title },
      requiredScopes: [signIn.scope],
      validateToken: (e) => (res, token) => as.validateToken<P>(res, token, e),
      handler: {
        async fetch(request: Request, env: E, ctx: OAuthResourceContext<P>) {
          if (!ctx.auth.scope.includes(signIn.scope)) return insufficientScope(ctx.auth, [signIn.scope]);
          const props = ctx.props;
          // Re-check on every request, so removing someone from the allowlist takes effect at once.
          if (!props || !signIn.isAllowed(env, props)) {
            return new Response("Forbidden", { status: 403 });
          }
          return handleMcp(request, cfg.tools, () => cfg.context(env, props), {
            serverInfo: { name: cfg.name, title: cfg.title, version: VERSION },
            instructions: cfg.instructions,
            allowedOrigins: env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
          });
        },
      },
    });

    roles = { key, as, rs };
    return roles;
  }

  async function route(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { as, rs } = getRoles(env);

    if (pathname === "/authorize") return handleAuthorize(request, env, as.getOAuthApi(env), signIn, cfg.title);
    if (pathname === "/callback") return handleCallback(request, env, as.getOAuthApi(env), ctx, signIn);
    if (pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return rs.fetch(request, env, ctx);
    }
    if (pathname === "/" && request.method === "GET") {
      return new Response(`${cfg.name} ${VERSION}: MCP endpoint at ${publicUrl(env)}/mcp\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    // Log every OAuth endpoint hit (path and status only) to make connector problems visible in `wrangler tail`.
    const res = await as.fetch(request, env, ctx);
    console.log(JSON.stringify({ event: "oauth_endpoint", method: request.method, path: pathname, status: res.status }));
    return res;
  }

  return {
    async fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      try {
        return await route(request, env, ctx);
      } catch (e) {
        console.log(JSON.stringify({ event: "unhandled", method: request.method, path: new URL(request.url).pathname, message: (e as Error)?.message }));
        return new Response(`Internal error: ${(e as Error)?.message ?? "unknown"}\n`, { status: 500, headers: { "Content-Type": "text/plain" } });
      }
    },
  };
}
