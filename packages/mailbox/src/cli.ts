import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import {
  deployCopies, deployMailroom, nextSteps, planMailroom, refuseMailroomRename, renderAll, status, succeeded, type Deps, type Report,
} from "./deploy.ts";
import { loadTemplates, ManifestError, parseManifest, resolveCopies } from "./manifest.ts";
import { wranglerRunner } from "./wrangler.ts";

const USAGE = "usage: mailbox <check | render | deploy | status> [names...] [--manifest FILE] [--mailroom] [--allow-change] [--no-input]";
const COMMANDS = ["check", "render", "deploy", "status"] as const;

export interface Args {
  command: (typeof COMMANDS)[number];
  names: string[];
  manifest?: string;
  mailroom: boolean;
  input: boolean;
  allowChange: boolean;
}

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Args["command"])) throw new Error(`unknown or missing command ${JSON.stringify(command)}\n${USAGE}`);
  const args: Args = { command: command as Args["command"], names: [], manifest: undefined, mailroom: false, input: true, allowChange: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--mailroom") args.mailroom = true;
    else if (a === "--allow-change") args.allowChange = true;
    else if (a === "--no-input") args.input = false;
    else if (a === "--manifest") {
      const value = rest[++i];
      if (value === undefined) throw new Error(`--manifest needs a file\n${USAGE}`);
      args.manifest = value;
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else args.names.push(a);
  }
  if (args.mailroom && args.command !== "deploy") throw new Error(`--mailroom is only for deploy\n${USAGE}`);
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
    exists: (file) => existsSync(file),
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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Runs a parsed command. Exit code: 0 done, 2 usage error, 1 anything else that went wrong. */
export async function execute(args: Args, deps: Deps, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  if (args.mailroom && args.command !== "deploy") {
    err(`--mailroom is only for deploy\n${USAGE}`);
    return 2;
  }
  try {
    const manifest = parseManifest(deps.read(deps.manifestPath));
    const known = Object.keys(manifest.mailboxes);
    const unknown = args.names.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      err(`unknown mailbox ${unknown.join(", ")}; the manifest has: ${known.join(", ")}`);
      return 1;
    }
    const templates = loadTemplates(deps.repoRoot);
    const allCopies = resolveCopies(manifest, templates);
    const chosen = args.names.length > 0 ? args.names : known;
    const copies = allCopies.filter((c) => chosen.includes(c.mailbox));

    if (args.command === "check") {
      const [m, b, w] = [table(copies, (c) => c.mailbox), table(copies, (c) => c.broker), table(copies, (c) => c.worker)];
      for (const c of copies) out(`${c.mailbox.padEnd(m)}  ${c.broker.padEnd(b)}  ${c.worker.padEnd(w)}  ${c.url}`);
      if (manifest.mailroom) planMailroom(manifest, allCopies, deps);
      return 0;
    }

    if (args.command === "render") {
      // Mailroom's config describes every mailbox, so it is only rendered when all of them are chosen.
      const written = await renderAll(manifest, copies, allCopies, templates, deps, { mailroom: args.names.length === 0, allowChange: args.allowChange });
      for (const file of written) out(`wrote ${file}`);
      return copies.every((c) => written.includes(c.configPath)) ? 0 : 1;
    }
    if (args.command === "status") {
      const reports = await status(copies, deps);
      for (const line of reportLines(reports)) out(line);
      return succeeded(reports) ? 0 : 1;
    }

    if (args.mailroom) {
      if (!manifest.mailroom) {
        err('the manifest has no "mailroom" entry');
        return 1;
      }
      // Everything that can be known about mailroom's config is checked before the first copy is deployed.
      refuseMailroomRename(planMailroom(manifest, allCopies, deps), deps, args.allowChange);
    }
    const reports = await deployCopies(copies, allCopies, templates, deps, { allowChange: args.allowChange });
    for (const line of reportLines(reports)) out(line);
    let code = succeeded(reports) ? 0 : 1;
    let mailroomDeployed = false;
    if (args.mailroom && code === 0) {
      try {
        await deployMailroom(manifest, allCopies, deps, { allowChange: args.allowChange });
        mailroomDeployed = true;
        out("mailroom deployed");
      } catch (e) {
        err(message(e));
        code = 1;
      }
    }
    const selected = { ...manifest, mailroom: mailroomDeployed ? manifest.mailroom : undefined };
    selected.mailboxes = Object.fromEntries(chosen.map((n) => [n, manifest.mailboxes[n]]));
    const ok = reports.filter((r) => r.error === undefined);
    for (const line of nextSteps(selected, copies.filter((c) => ok.some((r) => r.mailbox === c.mailbox && r.broker === c.broker)))) out(line);
    return code;
  } catch (e) {
    err(message(e));
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(message(e));
    return 2;
  }
  return execute(args, realDeps(args, manifestPath(args, process.env, repoRoot)), console.log, console.error);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
