// The HTML pages of the sign-in flow: consent and error.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(title: string, body: string, headers?: Headers, status = 200): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}}
code{font-size:.95em}.warn{border-left:3px solid #c80;padding-left:.8rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head>
<body>${body}</body></html>`,
    { status, headers: h },
  );
}

export function consentPage(
  d: ConsentDescription,
  handle: string,
  headers: Headers,
  text: { title: string; label: string; grants: string },
): Response {
  const who = d.clientDomain ? `${escapeHtml(d.clientName)} (verified domain ${escapeHtml(d.clientDomain)})` : escapeHtml(d.clientName);
  return page(
    `Connect ${text.title}`,
    `<h1>Connect ${escapeHtml(text.title)}</h1>
<p><strong>${who}</strong> ${escapeHtml(text.grants)}</p>
<p>Access will be sent to <code>${escapeHtml(d.redirectHost)}</code>${d.redirectIsLoopback ? " (an app on this computer)" : ""}.</p>
<p class="warn">Only continue if you started this yourself, from Claude, and that host is <code>claude.ai</code> (or <code>localhost</code> for Claude Code).</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Continue to ${escapeHtml(text.label)}</button>
<button name="decision" value="deny">Deny</button>
</form>`,
    headers,
  );
}

export function errorPage(message: string, status = 400): Response {
  return page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>`, undefined, status);
}
