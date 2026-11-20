import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplates, ManifestError, parseManifest, resolveCopies } from "./manifest.ts";

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

/** Exit code. */
export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.command !== "check") {
    console.error(`${args.command}: not implemented`);
    return 1;
  }
  try {
    const manifest = parseManifest(readFileSync(manifestPath(args, process.env, repoRoot), "utf8"));
    const copies = resolveCopies(manifest, loadTemplates(repoRoot));
    const width = (pick: (c: (typeof copies)[number]) => string) => Math.max(...copies.map((c) => pick(c).length));
    const [m, b, w] = [width((c) => c.mailbox), width((c) => c.broker), width((c) => c.worker)];
    for (const c of copies) console.log(`${c.mailbox.padEnd(m)}  ${c.broker.padEnd(b)}  ${c.worker.padEnd(w)}  ${c.url}`);
    return 0;
  } catch (e) {
    console.error(e instanceof ManifestError ? e.message : `${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
