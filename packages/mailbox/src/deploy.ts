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
  exists(path: string): boolean;
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
/** A new custom-domain hostname needs DNS and then a certificate: wait up to ten minutes for it. */
const VERIFY_ATTEMPTS_NEW_HOSTNAME = 120;
const GENERATED_PREFIX = `${serialize({}, "").split(" from ")[0]} from `;

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

interface DnsAnswer {
  Answer?: unknown;
}

/** Whether a public DNS-over-HTTPS resolver has an A answer for the host. False on any error. */
export async function publiclyResolves(host: string, deps: Deps): Promise<boolean> {
  try {
    const response = await deps.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    if (response.status !== 200) return false;
    const answer = ((await response.json()) as DnsAnswer | null)?.Answer;
    return Array.isArray(answer) && answer.length > 0;
  } catch {
    return false;
  }
}

/**
 * Probes up to `attempts` times, sleeping 5000 ms between, until the version is deps.version and the issuer matches.
 * A custom domain is not probed until public DNS answers for it (this machine's own resolver would cache the empty
 * answer for half an hour); each wait counts as an attempt.
 */
export async function verify(copy: Copy, deps: Deps, attempts: number): Promise<{ version?: string; verified: boolean }> {
  let version: string | undefined;
  let resolved = !copy.customDomain;
  let announced = false;
  for (let i = 0; i < attempts; i++) {
    if (!resolved) {
      resolved = await publiclyResolves(copy.host, deps);
      if (!resolved && !announced) {
        announced = true;
        deps.log(`waiting for ${copy.host}: a new hostname needs a few minutes for DNS and its certificate`);
      }
    }
    if (resolved) {
      const seen = await probe(copy, deps);
      version = seen.version;
      if (seen.version === deps.version && seen.issuer) return { version, verified: true };
    }
    if (i < attempts - 1) await deps.sleep(ATTEMPT_PAUSE_MS);
  }
  return { version, verified: false };
}

function templateOf(copy: Copy, templates: Template[]): Template {
  const template = templates.find((t) => t.broker === copy.broker);
  if (!template) throw new Error(`no template for broker "${copy.broker}"`);
  return template;
}

interface MailroomPlan {
  dir: string;
  path: string;
  text: string;
  config: Record<string, unknown>;
}

/** Everything deployMailroom does short of writing and deploying. Throws Error. */
export function planMailroom(manifest: Manifest, all: Copy[], deps: Deps): MailroomPlan {
  if (!manifest.mailroom) throw new Error('the manifest has no "mailroom" entry');
  const dir = resolve(dirname(deps.manifestPath), manifest.mailroom.dir);
  const file = join(dir, "wrangler.example.jsonc");
  let source: string;
  try {
    source = deps.read(file);
  } catch (e) {
    throw new Error(`mailroom: cannot read ${file}: ${(e as Error).message}`);
  }
  const errors: ParseError[] = [];
  const example: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${file}: ${errors.map((e) => printParseErrorCode(e.error)).join("; ")}`);
  if (typeof example !== "object" || example === null || Array.isArray(example)) throw new Error(`${file}: must be an object`);
  const config = renderMailroom(manifest, all, example as Record<string, unknown>);
  return { dir, path: join(dir, "wrangler.jsonc"), text: serialize(config, deps.manifestPath), config };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function bindingsOf(config: Record<string, unknown> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const services = config?.services;
  if (!Array.isArray(services)) return out;
  for (const s of services as unknown[]) {
    const item = s as { service?: unknown; binding?: unknown } | null;
    if (typeof item?.service === "string" && typeof item.binding === "string") out.set(item.service, item.binding);
  }
  return out;
}

/** Throws when the config on disk binds a service as another name than the plan does: mailroom keys its read positions by it. */
export function refuseMailroomRename(plan: MailroomPlan, deps: Deps, allowChange: boolean | undefined): void {
  if (allowChange || !deps.exists(plan.path)) return;
  const before = bindingsOf(parseObject(deps.read(plan.path)));
  const lines: string[] = [];
  for (const [service, binding] of bindingsOf(plan.config)) {
    const old = before.get(service);
    if (old !== undefined && old !== binding) {
      lines.push(
        `mailroom: this would rename the binding of ${service} from ${old} to ${binding}, and mailroom would lose its read positions; if that is intended, run again with --allow-change`,
      );
    }
  }
  if (lines.length > 0) throw new Error(lines.join("\n"));
}

/** Keeps a hand-written config once as <path>.bak, then writes the plan. */
function writeMailroom(plan: MailroomPlan, deps: Deps, allowChange: boolean | undefined): void {
  refuseMailroomRename(plan, deps, allowChange);
  if (deps.exists(plan.path)) {
    const old = deps.read(plan.path);
    const backup = `${plan.path}.bak`;
    if (!old.startsWith(GENERATED_PREFIX) && !deps.exists(backup)) {
      deps.write(backup, old);
      deps.log(`kept the hand-written ${plan.path} as ${backup}`);
    }
  }
  deps.write(plan.path, plan.text);
}

/** `<mailbox>/<broker>: this would change ...` when the file already on disk is another Worker, namespace or public url. */
function identityChange(copy: Copy, config: Record<string, unknown>, deps: Deps): string | undefined {
  if (!deps.exists(copy.configPath)) return undefined;
  const idOf = (c: Record<string, unknown> | undefined): string | undefined => {
    const kv = c?.kv_namespaces;
    const id = Array.isArray(kv) ? (kv[0] as { id?: unknown } | undefined)?.id : undefined;
    return typeof id === "string" ? id : undefined;
  };
  const publicUrlOf = (c: Record<string, unknown> | undefined): string | undefined => {
    const url = (c?.vars as { PUBLIC_URL?: unknown } | undefined)?.PUBLIC_URL;
    return typeof url === "string" ? url : undefined;
  };
  const old = parseObject(deps.read(copy.configPath));
  const unreadable = "(unreadable)";
  const items: [string, string | undefined, string | undefined][] = [
    ["name", old === undefined ? unreadable : (old.name as string | undefined), config.name as string],
    ["KV namespace", old === undefined ? unreadable : idOf(old), idOf(config)],
    ["PUBLIC_URL", old === undefined ? unreadable : publicUrlOf(old), publicUrlOf(config)],
  ];
  const changes = items.filter(([, was, now]) => was !== now).map(([what, was, now]) => `${what} from ${was ?? "(none)"} to ${now ?? "(none)"}`);
  if (changes.length === 0) return undefined;
  return `${copy.mailbox}/${copy.broker}: this would change ${changes.join(", ")}; if that is intended, run again with --allow-change`;
}

/** Id of each KV namespace as far as it is known, by the first copy (in order) that has it. */
function kvOwners(all: Copy[], namespaces: Map<string, string>): Map<string, Copy> {
  const owners = new Map<string, Copy>();
  for (const copy of all) {
    const id = copy.kvId ?? namespaces.get(copy.kvTitle);
    if (id !== undefined && !owners.has(id)) owners.set(id, copy);
  }
  return owners;
}

function checkKvUnique(copy: Copy, kvId: string, owners: Map<string, Copy>): void {
  const owner = owners.get(kvId);
  if (owner !== undefined && owner !== copy) throw new Error(`KV namespace ${kvId} is already used by ${owner.mailbox}/${owner.broker}`);
}

/**
 * Writes every config whose KV id is known (and, with `mailroom`, mailroom's). Creates nothing and deploys nothing.
 * Returns the paths written; a copy left out is logged.
 */
export async function renderAll(
  manifest: Manifest,
  chosen: Copy[],
  all: Copy[],
  templates: Template[],
  deps: Deps,
  opts: { mailroom?: boolean; allowChange?: boolean } = {},
): Promise<string[]> {
  const plan = opts.mailroom && manifest.mailroom ? planMailroom(manifest, all, deps) : undefined;
  if (plan) refuseMailroomRename(plan, deps, opts.allowChange);
  const namespaces = await kvNamespaces(deps.run, deps.repoRoot);
  const owners = kvOwners(all, namespaces);
  const written: string[] = [];
  for (const copy of chosen) {
    const kvId = copy.kvId ?? namespaces.get(copy.kvTitle);
    if (kvId === undefined) {
      deps.log(`not rendered: ${copy.mailbox}/${copy.broker} (KV namespace "${copy.kvTitle}" does not exist yet; deploy creates it)`);
      continue;
    }
    const owner = owners.get(kvId);
    if (owner !== undefined && owner !== copy) {
      deps.log(`not rendered: ${copy.mailbox}/${copy.broker} (KV namespace ${kvId} is already used by ${owner.mailbox}/${owner.broker})`);
      continue;
    }
    const config = renderBroker(copy, templateOf(copy, templates), kvId);
    const refused = opts.allowChange ? undefined : identityChange(copy, config, deps);
    if (refused !== undefined) {
      deps.log(`not rendered: ${refused}`);
      continue;
    }
    deps.write(copy.configPath, serialize(config, deps.manifestPath));
    written.push(copy.configPath);
  }
  if (plan) {
    writeMailroom(plan, deps, opts.allowChange);
    written.push(plan.path);
  }
  return written;
}

/** How often the secret list is read before a secret is believed missing, and the wait between reads. */
export const SECRET_READS = 3;
export const SECRET_READ_WAIT_MS = 2000;

/**
 * The required secrets a copy lacks, and whether its Worker exists. Cloudflare can answer an
 * empty or partial list for a moment after a deploy, so a secret counts as present once any
 * read shows it, and one is only reported missing after SECRET_READS reads agree.
 */
async function secretsMissing(copy: Copy, deps: Deps): Promise<{ missing: string[]; exists: boolean }> {
  const first = await secretNames(deps.run, deps.repoRoot, copy.worker);
  if (first === null) return { missing: [...copy.secrets], exists: false };
  const seen = new Set(first);
  let reads = 1;
  let missing = copy.secrets.filter((name) => !seen.has(name));
  while (missing.length > 0 && reads < SECRET_READS) {
    await deps.sleep(SECRET_READ_WAIT_MS);
    for (const name of (await secretNames(deps.run, deps.repoRoot, copy.worker)) ?? []) seen.add(name);
    reads++;
    missing = copy.secrets.filter((name) => !seen.has(name));
  }
  return { missing, exists: true };
}

async function deployCopy(
  copy: Copy,
  template: Template,
  namespaces: Map<string, string>,
  owners: Map<string, Copy>,
  deps: Deps,
  report: Report,
  allowChange: boolean | undefined,
): Promise<void> {
  let kvId = copy.kvId ?? namespaces.get(copy.kvTitle);
  if (kvId !== undefined) checkKvUnique(copy, kvId, owners);

  // Whether the Worker exists is asked once, before anything is created or deployed.
  const before = copy.customDomain || kvId === undefined ? await secretNames(deps.run, deps.repoRoot, copy.worker) : undefined;
  if (before === null && copy.customDomain && (await publiclyResolves(copy.host, deps))) {
    // wrangler, with its output piped, takes over an existing custom domain or DNS record without asking
    throw new Error(`${copy.host} already resolves, so it belongs to something else; remove that or give this copy another "url"`);
  }
  if (kvId === undefined) {
    // Only a Worker that does not exist may get a new namespace: an existing one has data in some other namespace.
    if (before !== null) {
      throw new Error(`worker ${copy.worker} exists but no KV namespace titled "${copy.kvTitle}" was found; set "kv" for it in the manifest`);
    }
    kvId = await createKv(deps.run, deps.repoRoot, copy.kvTitle);
    checkKvUnique(copy, kvId, owners);
  }

  const config = renderBroker(copy, template, kvId);
  const refused = allowChange ? undefined : identityChange(copy, config, deps);
  if (refused !== undefined) throw new Error(refused);
  deps.write(copy.configPath, serialize(config, deps.manifestPath));
  report.versionId = await deployConfig(deps.run, copy.dir, copy.configPath);

  let { missing } = await secretsMissing(copy, deps);
  report.missingSecrets = missing;
  if (missing.length > 0 && deps.interactive) {
    for (const name of missing) {
      const put = await deps.run(["secret", "put", name, "--name", copy.worker], { cwd: deps.repoRoot, interactive: true });
      if (put.code !== 0) throw new Error(`wrangler secret put ${name} --name ${copy.worker} failed (exit ${put.code})`);
    }
    ({ missing } = await secretsMissing(copy, deps));
    report.missingSecrets = missing;
  }
  if (!deps.interactive) for (const name of missing) deps.log(`npx wrangler secret put ${name} --name ${copy.worker}`);

  const seen = await verify(copy, deps, copy.customDomain ? VERIFY_ATTEMPTS_NEW_HOSTNAME : VERIFY_ATTEMPTS);
  report.version = seen.version;
  report.verified = seen.verified;
}

function newReport(copy: Copy): Report {
  return { mailbox: copy.mailbox, broker: copy.broker, worker: copy.worker, url: copy.url, missingSecrets: [], verified: false };
}

/**
 * Creates (when the Worker is new), renders, deploys and verifies each chosen copy in order; one failure does not stop the rest.
 * `all` is every copy of the manifest, so that no two of them end up on one KV namespace.
 */
export async function deployCopies(
  chosen: Copy[],
  all: Copy[],
  templates: Template[],
  deps: Deps,
  opts: { allowChange?: boolean } = {},
): Promise<Report[]> {
  const namespaces = await kvNamespaces(deps.run, deps.repoRoot);
  const owners = kvOwners(all, namespaces);
  const reports: Report[] = [];
  for (const copy of chosen) {
    const report = newReport(copy);
    reports.push(report);
    try {
      await deployCopy(copy, templateOf(copy, templates), namespaces, owners, deps, report, opts.allowChange);
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  }
  return reports;
}

/** Writes mailroom's config next to its example and deploys it from there. */
export async function deployMailroom(manifest: Manifest, all: Copy[], deps: Deps, opts: { allowChange?: boolean } = {}): Promise<void> {
  const plan = planMailroom(manifest, all, deps);
  writeMailroom(plan, deps, opts.allowChange);
  await deployConfig(deps.run, plan.dir, "wrangler.jsonc");
}

/** Probes each copy once and lists its secrets; writes nothing. */
export async function status(copies: Copy[], deps: Deps): Promise<Report[]> {
  const reports: Report[] = [];
  for (const copy of copies) {
    const report = newReport(copy);
    reports.push(report);
    try {
      const { missing, exists } = await secretsMissing(copy, deps);
      report.missingSecrets = missing;
      if (!exists) report.error = "not deployed";
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
