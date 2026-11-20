import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { deployCopies, deployMailroom, nextSteps, renderAll, status, succeeded, type Deps, type Report } from "./deploy.ts";
import { loadTemplates, ManifestError, parseManifest, resolveCopies, type Manifest } from "./manifest.ts";
import { wranglerRunner } from "./wrangler.ts";

const USAGE = "usage: mailbox <check | render | deploy | status> [names...] [--manifest FILE] [--mailroom] [--no-input]";
const COMMANDS = ["check", "render", "deploy", "status"] as const;

export interface Args {
  command: (typeof COMMANDS)[number];
  names: string[];
  manifest?: string;
  mailroom: boolean;
  input: boolean;
}

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Args["command"])) throw new Error(`unknown or missing command ${JSON.stringify(command)}\n${USAGE}`);
  const args: Args = { command: command as Args["command"], names: [], manifest: undefined, mailroom: false, input: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--mailroom") args.mailroom = true;
    else if (a === "--no-input") args.input = false;
    else if (a === "--manifest") {
      const value = rest[++i];
      if (value === undefined) throw new Error(`--manifest needs a file\n${USAGE}`);
      args.manifest = value;
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else args.names.push(a);
  }
  return args;
}

export function manifestPath(args: Args, env: Record<string, string | undefined>, repoRoot: string): string {
  return args.manifest ?? (env.MAILBOXES || join(repoRoot, "mailboxes.jsonc"));
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function realDeps(args: Args, path: string): Deps {
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  return {
    run: wranglerRunner(repoRoot),
    fetch: globalThis.fetch,
    log: (line) => console.log(line),
    sleep: (ms) => setTimeout(ms),
    read: (file) => readFileSync(file, "utf8"),
    write: (file, text) => writeFileSync(file, text),
    interactive: args.input && process.stdin.isTTY === true,
    version,
    repoRoot,
    manifestPath: path,
  };
}

function table<T>(rows: T[], pick: (row: T) => string): number {
  return Math.max(0, ...rows.map((r) => pick(r).length));
}

function reportLines(reports: Report[]): string[] {
  const [m, b, w] = [table(reports, (r) => r.mailbox), table(reports, (r) => r.broker), table(reports, (r) => r.worker)];
  return reports.map((r) => {
    const cells = [r.mailbox.padEnd(m), r.broker.padEnd(b), r.worker.padEnd(w), r.version ?? "-", r.verified ? "verified" : "UNVERIFIED"];
    if (r.missingSecrets.length > 0) cells.push(`missing: ${r.missingSecrets.join(", ")}`);
    if (r.error !== undefined) cells.push(r.error);
    return cells.join("  ");
  });
}

/** Exit code: 0 done, 2 usage error, 1 anything else that went wrong. */
export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  try {
    const path = manifestPath(args, process.env, repoRoot);
    const manifest = parseManifest(readFileSync(path, "utf8"));
    const known = Object.keys(manifest.mailboxes);
    const unknown = args.names.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      console.error(`unknown mailbox ${unknown.join(", ")}; the manifest has: ${known.join(", ")}`);
      return 1;
    }
    const templates = loadTemplates(repoRoot);
    const allCopies = resolveCopies(manifest, templates);
    const chosen = args.names.length > 0 ? args.names : known;
    const copies = allCopies.filter((c) => chosen.includes(c.mailbox));

    if (args.command === "check") {
      const [m, b, w] = [table(copies, (c) => c.mailbox), table(copies, (c) => c.broker), table(copies, (c) => c.worker)];
      for (const c of copies) console.log(`${c.mailbox.padEnd(m)}  ${c.broker.padEnd(b)}  ${c.worker.padEnd(w)}  ${c.url}`);
      return 0;
    }

    const deps = realDeps(args, path);
    // Mailroom's config describes every mailbox, so it is only rendered when all of them are chosen.
    const selected: Manifest = { ...manifest, mailboxes: Object.fromEntries(chosen.map((n) => [n, manifest.mailboxes[n]])) };
    if (args.command === "render") {
      const forAll = args.names.length === 0 ? manifest : { ...manifest, mailroom: undefined };
      for (const file of await renderAll(forAll, copies, templates, deps)) console.log(`wrote ${file}`);
      return 0;
    }
    if (args.command === "status") {
      const reports = await status(copies, deps);
      for (const line of reportLines(reports)) console.log(line);
      return succeeded(reports) ? 0 : 1;
    }

    if (args.mailroom && !manifest.mailroom) throw new Error('the manifest has no "mailroom" entry');
    const reports = await deployCopies(copies, templates, deps);
    for (const line of reportLines(reports)) console.log(line);
    for (const line of nextSteps(selected, copies)) console.log(line);
    if (!succeeded(reports)) return 1;
    if (args.mailroom) {
      await deployMailroom(manifest, allCopies, deps);
      console.log("mailroom deployed");
    }
    return 0;
  } catch (e) {
    console.error(e instanceof ManifestError ? e.message : (e as Error).message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
