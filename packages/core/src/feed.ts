// Helpers shared by the brokers' Feed entrypoints (read-only, reached by service binding).
// The routes themselves stay in each broker.

/** JSON answer; no body for 204, 205 and 304. */
export function json(body: unknown, status = 200): Response {
  if (status === 204 || status === 205 || status === 304) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

/**
 * Runs a Feed route and writes one audit line. If `run` throws, the answer is the generic
 * one `failure` describes; the exception's message goes to the log line only.
 */
export async function auditedFeed(
  request: Request,
  run: () => Promise<Response>,
  failure: (e: unknown) => { status: number; error: string },
): Promise<Response> {
  const started = Date.now();
  let res: Response;
  let message: string | undefined;
  try {
    res = await run();
  } catch (e) {
    const f = failure(e);
    res = json({ error: f.error }, f.status);
    message = (e as Error)?.message ?? String(e);
  }
  const line = { event: "feed", method: request.method, path: new URL(request.url).pathname, status: res.status, ms: Date.now() - started };
  console.log(JSON.stringify(message === undefined ? line : { ...line, message }));
  return res;
}
