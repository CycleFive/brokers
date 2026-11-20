import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export interface BrokerEntry {
  worker?: string;
  url?: string;
  kv?: string;
  binding?: string;
  vars?: Record<string, string>;
}
export interface MailSource {
  type: string;
  broker: string;
  [key: string]: unknown;
}
export interface MailEntry {
  signin: string;
  sources: MailSource[];
}
export interface MailboxEntry {
  brokers: Record<string, BrokerEntry>;
  mail?: MailEntry;
}
export interface MailroomEntry {
  dir: string;
  url?: string;
  retain_days?: number;
}
export interface Manifest {
  hostname?: string;
  mailroom?: MailroomEntry;
  lists?: Record<string, string[]>;
  mailboxes: Record<string, MailboxEntry>;
}

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ManifestError";
    this.problems = problems;
  }
}

const MAILBOX_NAME = /^[a-z0-9-]{1,32}$/;
const BINDING_NAME = /^[A-Z][A-Z0-9_]*$/;
const LIST_REF = /^\$lists\.(.+)$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHttpsOrigin(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.origin === v;
  } catch {
    return false;
  }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Replaces every string that is exactly "$lists.<name>" with a copy of that list. */
function expandLists(value: unknown, path: string, lists: Record<string, string[]>, problems: string[]): unknown {
  if (typeof value === "string") {
    const name = LIST_REF.exec(value)?.[1];
    if (name === undefined) return value;
    if (Object.hasOwn(lists, name)) return [...lists[name]];
    problems.push(`${path}: unknown list "${name}" (no lists.${name})`);
    return [];
  }
  if (Array.isArray(value)) return value.map((v, i) => expandLists(v, `${path}[${i}]`, lists, problems));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandLists(v, `${path}.${k}`, lists, problems);
    return out;
  }
  return value;
}

function checkKeys(obj: Obj, allowed: string[], path: string, problems: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) problems.push(`${path ? `${path}.${k}` : k}: unknown key (allowed: ${allowed.join(", ")})`);
  }
}

function checkBroker(raw: unknown, path: string, problems: string[]): BrokerEntry | undefined {
  if (!isObj(raw)) {
    problems.push(`${path}: must be an object`);
    return undefined;
  }
  checkKeys(raw, ["worker", "url", "kv", "binding", "vars"], path, problems);
  const entry: BrokerEntry = {};
  for (const key of ["worker", "kv"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "string" && v !== "") entry[key] = v;
    else problems.push(`${path}.${key}: must be a non-empty string`);
  }
  if (raw.url !== undefined) {
    if (isHttpsOrigin(raw.url)) entry.url = raw.url;
    else problems.push(`${path}.url: must be an https origin with no path or trailing slash (got ${JSON.stringify(raw.url)})`);
  }
  if (raw.binding !== undefined) {
    if (typeof raw.binding === "string" && BINDING_NAME.test(raw.binding)) entry.binding = raw.binding;
    else problems.push(`${path}.binding: must match ${BINDING_NAME} (got ${JSON.stringify(raw.binding)})`);
  }
  if (raw.vars !== undefined) {
    if (!isObj(raw.vars)) problems.push(`${path}.vars: must be an object`);
    else {
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.vars)) {
        if (typeof v === "string") vars[k] = v;
        else problems.push(`${path}.vars.${k}: must be a string`);
      }
      entry.vars = vars;
    }
  }
  return entry;
}

function checkMail(raw: unknown, path: string, brokers: Record<string, BrokerEntry>, problems: string[]): MailEntry | undefined {
  if (!isObj(raw)) {
    problems.push(`${path}: must be an object`);
    return undefined;
  }
  checkKeys(raw, ["signin", "sources"], path, problems);
  const names = Object.keys(brokers);
  let signin = "";
  if (typeof raw.signin === "string" && Object.hasOwn(brokers, raw.signin)) signin = raw.signin;
  else problems.push(`${path}.signin: must name a broker of this mailbox (${names.join(", ")}), got ${JSON.stringify(raw.signin)}`);
  const sources: MailSource[] = [];
  if (!Array.isArray(raw.sources)) problems.push(`${path}.sources: must be an array`);
  else {
    raw.sources.forEach((s: unknown, i: number) => {
      const p = `${path}.sources[${i}]`;
      if (!isObj(s)) return void problems.push(`${p}: must be an object`);
      if (typeof s.type !== "string" || s.type === "") problems.push(`${p}.type: must be a non-empty string`);
      if (typeof s.broker !== "string" || !Object.hasOwn(brokers, s.broker)) {
        problems.push(`${p}.broker: must name a broker of this mailbox (${names.join(", ")}), got ${JSON.stringify(s.broker)}`);
      }
      sources.push(s as MailSource);
    });
  }
  return { signin, sources };
}

function checkMailbox(name: string, raw: unknown, problems: string[]): MailboxEntry | undefined {
  const path = `mailboxes.${name}`;
  if (name === "example") problems.push(`${path}: "example" is reserved for the example config`);
  else if (!MAILBOX_NAME.test(name)) problems.push(`${path}: name must match ${MAILBOX_NAME}`);
  if (!isObj(raw)) {
    problems.push(`${path}: must be an object`);
    return undefined;
  }
  checkKeys(raw, ["brokers", "mail"], path, problems);
  const brokers: Record<string, BrokerEntry> = {};
  if (!isObj(raw.brokers) || Object.keys(raw.brokers).length === 0) problems.push(`${path}.brokers: must be a non-empty object`);
  else {
    for (const [b, entry] of Object.entries(raw.brokers)) {
      const checked = checkBroker(entry, `${path}.brokers.${b}`, problems);
      if (checked) brokers[b] = checked;
    }
  }
  const out: MailboxEntry = { brokers };
  if (raw.mail !== undefined) {
    const mail = checkMail(raw.mail, `${path}.mail`, brokers, problems);
    if (mail) out.mail = mail;
  }
  return out;
}

/** JSONC text to a checked Manifest with every "$lists.<name>" replaced. Throws ManifestError. */
export function parseManifest(text: string): Manifest {
  const errors: ParseError[] = [];
  const raw: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ManifestError(errors.map((e) => `line ${lineOf(text, e.offset)}: ${printParseErrorCode(e.error)}`));
  }
  if (!isObj(raw)) throw new ManifestError(["(top level): must be an object"]);

  const problems: string[] = [];
  checkKeys(raw, ["hostname", "mailroom", "lists", "mailboxes"], "", problems);
  const manifest: Manifest = { mailboxes: {} };

  if (raw.hostname !== undefined) {
    if (typeof raw.hostname === "string" && raw.hostname.includes("{mailbox}") && raw.hostname.includes("{broker}")) {
      manifest.hostname = raw.hostname;
    } else problems.push(`hostname: must contain both {mailbox} and {broker}`);
  }

  if (raw.mailroom !== undefined) {
    const m = raw.mailroom;
    if (!isObj(m)) problems.push("mailroom: must be an object");
    else {
      checkKeys(m, ["dir", "url", "retain_days"], "mailroom", problems);
      const entry: MailroomEntry = { dir: "" };
      if (typeof m.dir === "string" && m.dir !== "") entry.dir = m.dir;
      else problems.push("mailroom.dir: must be a non-empty string");
      if (m.url !== undefined) {
        if (isHttpsOrigin(m.url)) entry.url = m.url;
        else problems.push(`mailroom.url: must be an https origin with no path or trailing slash (got ${JSON.stringify(m.url)})`);
      }
      if (m.retain_days !== undefined) {
        if (typeof m.retain_days === "number" && Number.isInteger(m.retain_days) && m.retain_days >= 0) entry.retain_days = m.retain_days;
        else problems.push("mailroom.retain_days: must be a non-negative integer");
      }
      manifest.mailroom = entry;
    }
  }

  const lists: Record<string, string[]> = {};
  if (raw.lists !== undefined) {
    if (!isObj(raw.lists)) problems.push("lists: must be an object");
    else {
      for (const [name, v] of Object.entries(raw.lists)) {
        if (Array.isArray(v) && v.every((x) => typeof x === "string")) lists[name] = v as string[];
        else problems.push(`lists.${name}: must be an array of strings`);
      }
      manifest.lists = lists;
    }
  }

  if (!isObj(raw.mailboxes) || Object.keys(raw.mailboxes).length === 0) problems.push("mailboxes: must be a non-empty object");
  else {
    const expanded = expandLists(raw.mailboxes, "mailboxes", lists, problems) as Obj;
    for (const [name, entry] of Object.entries(expanded)) {
      const checked = checkMailbox(name, entry, problems);
      if (checked) manifest.mailboxes[name] = checked;
    }
  }

  if (problems.length > 0) throw new ManifestError(problems);
  return manifest;
}

/** What one broker's wrangler.example.jsonc contributes. */
export interface Template {
  broker: string; // directory name under brokers/
  dir: string; // absolute path of that directory
  name: string; // the example's "name"
  vars: Record<string, string>; // the example's vars, in file order
  secrets: string[]; // the example's secrets.required
  config: Record<string, unknown>; // the whole parsed example
}

export function readTemplate(broker: string, dir: string, text: string): Template {
  const where = `brokers/${broker}/wrangler.example.jsonc`;
  const errors: ParseError[] = [];
  const raw: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`${where}: ${errors.map((e) => `line ${lineOf(text, e.offset)}: ${printParseErrorCode(e.error)}`).join("; ")}`);
  }
  if (!isObj(raw)) throw new Error(`${where}: must be an object`);

  const missing: string[] = [];
  if (typeof raw.name !== "string" || raw.name === "") missing.push(`"name" (a string)`);
  const vars: Record<string, string> = {};
  if (!isObj(raw.vars) || typeof raw.vars.PUBLIC_URL !== "string") missing.push(`"vars" with a string PUBLIC_URL`);
  else {
    for (const [k, v] of Object.entries(raw.vars)) {
      if (typeof v === "string") vars[k] = v;
      else missing.push(`"vars.${k}" as a string`);
    }
  }
  const required = isObj(raw.secrets) ? raw.secrets.required : undefined;
  if (!Array.isArray(required) || !required.every((s) => typeof s === "string")) missing.push(`"secrets.required" (an array of strings)`);
  if (!Array.isArray(raw.kv_namespaces) || raw.kv_namespaces.length !== 1) missing.push(`"kv_namespaces" with exactly one entry`);
  if (missing.length > 0) throw new Error(`${where} lacks ${missing.join(", ")}`);

  return { broker, dir, name: raw.name as string, vars, secrets: required as string[], config: raw };
}

export function loadTemplates(repoRoot: string): Template[] {
  const brokersDir = join(repoRoot, "brokers");
  const out: Template[] = [];
  for (const entry of readdirSync(brokersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(brokersDir, entry.name);
    let text: string;
    try {
      text = readFileSync(join(dir, "wrangler.example.jsonc"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push(readTemplate(entry.name, dir, text));
  }
  return out.sort((a, b) => (a.broker < b.broker ? -1 : a.broker > b.broker ? 1 : 0));
}

/** One broker copy of one mailbox, fully resolved. */
export interface Copy {
  mailbox: string;
  broker: string;
  dir: string;
  service: string; // template.name
  worker: string;
  url: string;
  host: string;
  customDomain: boolean;
  kvId?: string;
  kvTitle: string;
  binding: string;
  vars: Record<string, string>; // every template key in template order, PUBLIC_URL = url
  secrets: string[];
  configPath: string; // <dir>/wrangler.<mailbox>.jsonc
}

/** Mailboxes in manifest order, brokers in manifest order. Throws ManifestError. */
export function resolveCopies(manifest: Manifest, templates: Template[]): Copy[] {
  const problems: string[] = [];
  const copies: Copy[] = [];
  const paths = new Map<Copy, string>();

  for (const [mailbox, mb] of Object.entries(manifest.mailboxes)) {
    for (const [broker, entry] of Object.entries(mb.brokers)) {
      const path = `mailboxes.${mailbox}.brokers.${broker}`;
      const t = templates.find((x) => x.broker === broker);
      if (!t) {
        problems.push(`${path}: unknown broker "${broker}" (no brokers/${broker}/wrangler.example.jsonc)`);
        continue;
      }

      let url = entry.url;
      if (url === undefined) {
        if (manifest.hostname === undefined) {
          problems.push(`${path}.url: no url given and the manifest has no "hostname" pattern to build one from`);
          continue;
        }
        url = `https://${manifest.hostname.replaceAll("{mailbox}", mailbox).replaceAll("{broker}", broker)}`;
        if (!isHttpsOrigin(url)) {
          problems.push(`${path}.url: the hostname pattern gives ${JSON.stringify(url)}, which is not an https origin`);
          continue;
        }
      }
      const host = new URL(url).host;

      const given = entry.vars ?? {};
      for (const key of Object.keys(given)) {
        if (key === "PUBLIC_URL") problems.push(`${path}.vars.PUBLIC_URL: set from the url, do not give it`);
        else if (!Object.hasOwn(t.vars, key)) problems.push(`${path}.vars.${key}: not a variable of brokers/${broker}/wrangler.example.jsonc`);
      }
      const vars: Record<string, string> = {};
      for (const [key, example] of Object.entries(t.vars)) {
        if (key === "PUBLIC_URL") vars[key] = url;
        else if (Object.hasOwn(given, key)) vars[key] = given[key];
        else if (example === "") vars[key] = "";
        else problems.push(`${path}.vars.${key}: required (the example has ${JSON.stringify(example)})`);
      }

      const worker = entry.worker ?? `${t.name}-${mailbox}`;
      const copy: Copy = {
        mailbox,
        broker,
        dir: t.dir,
        service: t.name,
        worker,
        url,
        host,
        customDomain: !host.endsWith(".workers.dev"),
        kvId: entry.kv,
        kvTitle: `${worker}-oauth`,
        binding: entry.binding ?? `${broker}_${mailbox}`.toUpperCase().replaceAll("-", "_"),
        vars,
        secrets: t.secrets,
        configPath: join(t.dir, `wrangler.${mailbox}.jsonc`),
      };
      copies.push(copy);
      paths.set(copy, path);
    }
  }

  for (const field of ["worker", "url", "binding"] as const) {
    const seen = new Map<string, Copy>();
    for (const copy of copies) {
      const first = seen.get(copy[field]);
      if (first) problems.push(`${paths.get(copy)}.${field}: ${JSON.stringify(copy[field])} is already used by ${paths.get(first)}`);
      else seen.set(copy[field], copy);
    }
  }

  if (problems.length > 0) throw new ManifestError(problems);
  return copies;
}
