import { dirname, join, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Copy, Manifest, Template } from "./manifest.ts";
import { renderBroker, renderMailroom, serialize } from "./render.ts";
import { createKv, deployConfig, kvNamespaces, secretNames, type Run } from "./wrangler.ts";

export interface Deps {
  run: Run;
  fetch: typeof fetch;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  read(path: string): string;
  write(path: string, text: string): void;
  /** A terminal is attached and --no-input was not given. */
  interactive: boolean;
  /** The version in the root package.json. */
  version: string;
  repoRoot: string;
  manifestPath: string;
}

export interface Report {
  mailbox: string;
  broker: string;
  worker: string;
  url: string;
  /** What the banner says is deployed (on the last probe). */
  version?: string;
  /** From this run's deploy. */
  versionId?: string;
  missingSecrets: string[];
  /** The banner shows deps.version and the issuer equals url. */
  verified: boolean;
  error?: string;
}

interface Metadata {
  issuer?: unknown;
}

const ATTEMPT_PAUSE_MS = 5000;
const VERIFY_ATTEMPTS = 24;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getText(deps: Deps, url: string): Promise<string | undefined> {
  try {
    const response = await deps.fetch(url);
    return response.status === 200 ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

/** One GET of `<url>/` and one of `<url>/.well-known/oauth-authorization-server`. Never throws. */
export async function probe(copy: Copy, deps: Deps): Promise<{ version?: string; issuer: boolean }> {
  const banner = await getText(deps, `${copy.url}/`);
  const metadata = await getText(deps, `${copy.url}/.well-known/oauth-authorization-server`);
  const version = banner === undefined ? undefined : new RegExp(`^${escapeRegExp(copy.service)} (\\S+):`).exec(banner)?.[1];
  let issuer = false;
  if (metadata !== undefined) {
    try {
      issuer = (JSON.parse(metadata) as Metadata | null)?.issuer === copy.url;
    } catch {
      issuer = false;
    }
  }
  return version === undefined ? { issuer } : { version, issuer };
}

/** Probes up to `attempts` times, sleeping 5000 ms between, until the version is deps.version and the issuer matches. */
export async function verify(copy: Copy, deps: Deps, attempts: number): Promise<{ version?: string; verified: boolean }> {
  let version: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await deps.sleep(ATTEMPT_PAUSE_MS);
    const seen = await probe(copy, deps);
    version = seen.version;
    if (seen.version === deps.version && seen.issuer) return { version, verified: true };
  }
  return { version, verified: false };
}

function templateOf(copy: Copy, templates: Template[]): Template {
  const template = templates.find((t) => t.broker === copy.broker);
  if (!template) throw new Error(`no template for broker "${copy.broker}"`);
  return template;
}

/** The directory of mailroom, where its example sits and its config is written. */
function mailroomDir(manifest: Manifest, deps: Deps): string {
  if (!manifest.mailroom) throw new Error('the manifest has no "mailroom" entry');
  return resolve(dirname(deps.manifestPath), manifest.mailroom.dir);
}

function mailroomConfig(manifest: Manifest, copies: Copy[], deps: Deps): { dir: string; text: string } {
  const dir = mailroomDir(manifest, deps);
  const file = join(dir, "wrangler.example.jsonc");
  const source = deps.read(file);
  const errors: ParseError[] = [];
  const example: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${file}: ${errors.map((e) => printParseErrorCode(e.error)).join("; ")}`);
  if (typeof example !== "object" || example === null || Array.isArray(example)) throw new Error(`${file}: must be an object`);
  return { dir, text: serialize(renderMailroom(manifest, copies, example as Record<string, unknown>), deps.manifestPath) };
}

/** Writes every config whose KV id is known, and mailroom's. Creates nothing and deploys nothing. Returns the paths written. */
export async function renderAll(manifest: Manifest, copies: Copy[], templates: Template[], deps: Deps): Promise<string[]> {
  const namespaces = await kvNamespaces(deps.run, deps.repoRoot);
  const written: string[] = [];
  for (const copy of copies) {
    const kvId = copy.kvId ?? namespaces.get(copy.kvTitle);
    if (kvId === undefined) {
      deps.log(`not rendered: ${copy.mailbox}/${copy.broker} (KV namespace "${copy.kvTitle}" does not exist yet; deploy creates it)`);
      continue;
    }
    deps.write(copy.configPath, serialize(renderBroker(copy, templateOf(copy, templates), kvId), deps.manifestPath));
    written.push(copy.configPath);
  }
  if (manifest.mailroom) {
    const { dir, text } = mailroomConfig(manifest, copies, deps);
    const path = join(dir, "wrangler.jsonc");
    deps.write(path, text);
    written.push(path);
  }
  return written;
}

function missingFrom(copy: Copy, have: string[] | null): string[] {
  return copy.secrets.filter((name) => !(have ?? []).includes(name));
}

async function deployCopy(copy: Copy, template: Template, namespaces: Map<string, string>, deps: Deps, report: Report): Promise<void> {
  let kvId = copy.kvId ?? namespaces.get(copy.kvTitle);
  if (kvId === undefined) {
    // Only a Worker that does not exist may get a new namespace: an existing one has data in some other namespace.
    if ((await secretNames(deps.run, copy.dir, copy.worker)) !== null) {
      throw new Error(`worker ${copy.worker} exists but no KV namespace titled "${copy.kvTitle}" was found; set "kv" for it in the manifest`);
    }
    kvId = await createKv(deps.run, copy.dir, copy.kvTitle);
  }

  deps.write(copy.configPath, serialize(renderBroker(copy, template, kvId), deps.manifestPath));
  report.versionId = await deployConfig(deps.run, copy.dir, copy.configPath);

  let missing = missingFrom(copy, await secretNames(deps.run, copy.dir, copy.worker));
  if (missing.length > 0 && deps.interactive) {
    for (const name of missing) {
      const put = await deps.run(["secret", "put", name, "--name", copy.worker], { cwd: copy.dir, interactive: true });
      if (put.code !== 0) throw new Error(`wrangler secret put ${name} --name ${copy.worker} failed (exit ${put.code})`);
    }
    missing = missingFrom(copy, await secretNames(deps.run, copy.dir, copy.worker));
  }
  report.missingSecrets = missing;
  if (!deps.interactive) for (const name of missing) deps.log(`npx wrangler secret put ${name} --name ${copy.worker}`);

  const seen = await verify(copy, deps, VERIFY_ATTEMPTS);
  report.version = seen.version;
  report.verified = seen.verified;
}

function newReport(copy: Copy): Report {
  return { mailbox: copy.mailbox, broker: copy.broker, worker: copy.worker, url: copy.url, missingSecrets: [], verified: false };
}

/** Creates (when the Worker is new), renders, deploys and verifies each copy in order; one failure does not stop the rest. */
export async function deployCopies(copies: Copy[], templates: Template[], deps: Deps): Promise<Report[]> {
  const namespaces = await kvNamespaces(deps.run, deps.repoRoot);
  const reports: Report[] = [];
  for (const copy of copies) {
    const report = newReport(copy);
    reports.push(report);
    try {
      await deployCopy(copy, templateOf(copy, templates), namespaces, deps, report);
    } catch (e) {
      report.error = (e as Error).message;
    }
  }
  return reports;
}

/** Writes mailroom's config next to its example and deploys it from there. */
export async function deployMailroom(manifest: Manifest, copies: Copy[], deps: Deps): Promise<void> {
  const { dir, text } = mailroomConfig(manifest, copies, deps);
  deps.write(join(dir, "wrangler.jsonc"), text);
  await deployConfig(deps.run, dir, "wrangler.jsonc");
}

/** Probes each copy once and lists its secrets; writes nothing. */
export async function status(copies: Copy[], deps: Deps): Promise<Report[]> {
  const reports: Report[] = [];
  for (const copy of copies) {
    const report = newReport(copy);
    reports.push(report);
    try {
      const have = await secretNames(deps.run, copy.dir, copy.worker);
      report.missingSecrets = missingFrom(copy, have);
      if (have === null) report.error = "not deployed";
      const seen = await probe(copy, deps);
      report.version = seen.version;
      report.verified = seen.version === deps.version && seen.issuer;
    } catch (e) {
      report.error = (e as Error).message;
    }
  }
  return reports;
}

/** No error, no missing secret, everything verified. */
export function succeeded(reports: Report[]): boolean {
  return reports.every((r) => r.error === undefined && r.missingSecrets.length === 0 && r.verified);
}

/** What is left to enter by hand on the upstream applications and the sign-in application. */
export function nextSteps(manifest: Manifest, copies: Copy[]): string[] {
  const lines: string[] = [];
  for (const c of copies) {
    lines.push(`${c.mailbox}/${c.broker}  connect: ${c.url}/mcp`);
    lines.push(`${c.mailbox}/${c.broker}  redirect to allow on the upstream application: ${c.url}/callback`);
  }
  const mailroomUrl = manifest.mailroom?.url;
  if (mailroomUrl !== undefined) {
    for (const [mailbox, mb] of Object.entries(manifest.mailboxes)) {
      if (!mb.mail) continue;
      lines.push(`${mailbox}/mail  connect: ${mailroomUrl}/${mailbox}/mcp`);
      lines.push(`${mailbox}/mail  redirect to allow on the sign-in application: ${mailroomUrl}/callback`);
    }
  }
  return lines;
}
